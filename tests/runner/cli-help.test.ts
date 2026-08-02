import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli/circuit.js';
import { CLI_COMMAND_NAMES } from '../../src/cli/command-vocabulary.js';
import { renderFrontDoor } from '../../src/cli/front-door.js';
import { RUN_EXECUTION_FLAGS } from '../../src/cli/run-flag-vocabulary.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';

// The help and discovery layer of the CLI. These are behavior pins for the
// operator-facing contract: `circuit <cmd> --help` and `circuit help [cmd]`
// print real help (flags, one example, a next step) and exit 0 with nothing
// on stderr; bare `circuit runs`/`circuit history` name the missing
// subcommand in plain English; unknown commands and `--version` name their
// remedy. Help must RETURN its exit code, never call process.exit, so
// in-process callers (bin/circuit, tests) stay in control.

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Safety net: a regression that routes help back through Commander's
  // process.exit path must fail an assertion, not kill the vitest worker.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    return undefined as never;
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function captureMain(
  argv: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { result, stdout, stderr } = await captureStreams(() => main(argv));
  return { code: result, stdout, stderr };
}

describe('per-command help (B1)', () => {
  it('prints real help for every command: usage, an example, exit 0, silent stderr', async () => {
    for (const name of CLI_COMMAND_NAMES) {
      const result = await captureMain([name, '--help']);
      expect(result.code, `${name} --help exit code`).toBe(0);
      expect(result.stderr, `${name} --help stderr`).toBe('');
      expect(result.stdout, `${name} --help names the command`).toContain(`circuit ${name}`);
      expect(result.stdout, `${name} --help has a usage block`).toContain('usage:');
      expect(result.stdout, `${name} --help has an example`).toContain('example:');
      expect(result.stdout, `${name} --help has a next step`).toContain('next:');
      expect(exitSpy, `${name} --help must return, not process.exit`).not.toHaveBeenCalled();
    }
  });

  it('derives run help flags from the run flag vocabulary', async () => {
    const result = await captureMain(['run', '--help']);
    expect(result.code).toBe(0);
    for (const row of RUN_EXECUTION_FLAGS) {
      if (row.docValid) {
        expect(result.stdout, `run help lists ${row.flag}`).toContain(row.flag);
      } else {
        // docValid:false flags (--dry-run) are hard-rejected at parse time
        // and may not be taught anywhere, including help.
        expect(result.stdout, `run help must not teach ${row.flag}`).not.toContain(row.flag);
      }
    }
  });

  it('teaches the explicit-flow contract and a copy-pasteable example in run help', async () => {
    const result = await captureMain(['run', '--help']);
    expect(result.stdout).toContain('pass one of build|fix|review|explore|prototype|pursue');
    expect(result.stdout).toContain('the CLI never classifies the goal text');
    expect(result.stdout).toContain('circuit run fix --goal');
  });

  it('teaches Done-first review and the bounded, explicit file fallback in resume help', async () => {
    const result = await captureMain(['resume', '--help']);
    expect(result.stdout).toContain('--checkpoint-review');
    expect(result.stdout).toContain('regenerate the local review page');
    expect(result.stdout).toContain('Done saves comments and continues the run');
    expect(result.stdout).toContain('relative to current directory');
    expect(result.stdout).toContain('at most 64 KiB');
    expect(result.stdout).toContain(
      'opening or saving a file never approves a checkpoint by itself',
    );
    expect(result.stdout).toContain('manual fallback without review comments');
  });

  it('answers -h the same as --help', async () => {
    const result = await captureMain(['preview', '-h']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('--matrix');
  });

  it('treats --help after other flags as a help request', async () => {
    const result = await captureMain(['run', '--goal', 'x', '--help']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('--power');
  });
});

describe('the help command (B2)', () => {
  it('circuit help prints the orientation page and exits 0', async () => {
    const result = await captureMain(['help']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${renderFrontDoor()}\n`);
  });

  it('circuit help <cmd> prints that command help and exits 0', async () => {
    const result = await captureMain(['help', 'doctor']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('circuit doctor');
    expect(result.stdout).toContain('--json');
  });

  it('circuit help with an unknown topic exits 2 and points at the valid commands', async () => {
    const result = await captureMain(['help', 'frobnicate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command 'frobnicate'");
    expect(result.stderr).not.toContain('outputHelp');
    expect(result.stderr).toContain('circuit --help');
  });
});

describe('bare subcommand-family commands (B3)', () => {
  it('bare circuit runs prints the recent-runs listing instead of demanding a subcommand', async () => {
    const result = await captureMain(['runs']);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('outputHelp');
    // Either real runs or the honest empty state; never an invocation error.
    expect(result.stdout).toMatch(/saved run/i);
  });

  // A usage error reaches a person at a terminal, so it goes to stderr as a
  // plain `error:` line like every other command's. `circuit history` used to
  // answer this one in a JSON envelope on stdout, which is the wrong stream
  // and the wrong language for someone who has not asked for JSON — and in the
  // `--json` case below, self-contradicting.
  it('bare circuit history names the missing subcommand and the valid ones', async () => {
    const result = await captureMain(['history']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('outputHelp');
    expect(result.stderr).toContain('history requires a subcommand');
    expect(result.stderr).toContain('query');
  });

  it('circuit history status without --json says so in plain text, not JSON', async () => {
    const result = await captureMain(['history', 'status']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('history commands require --json');
  });

  // A caller who did ask for JSON gets JSON, even for a usage error: it is
  // reading stdout with a parser, and a bare sentence would break it.
  it('circuit history --json keeps the machine envelope for a usage error', async () => {
    const result = await captureMain(['history', '--json']);
    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stdout) as { error: { message: string } };
    expect(envelope.error.message).toContain('history requires a subcommand');
  });

  it('bare circuit memory names the missing subcommand on stderr too', async () => {
    const result = await captureMain(['memory']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('memory requires a subcommand');
  });

  // The help block lists `--limit <n>` under flags, so reaching for it before
  // the subcommand is the ordinary slip. Commander answers "unknown option
  // '--limit'", which is false twice over: the option is known, and the thing
  // actually missing is the subcommand. A flag carrying a value made the old
  // check believe a subcommand had been named, because the value is a token
  // that does not start with a dash.
  it.each([
    { argv: ['history', '--limit', '5'], expected: 'history requires a subcommand' },
    { argv: ['memory', '--limit', '3'], expected: 'memory requires a subcommand' },
  ])('$argv names the missing subcommand, not the flag', async ({ argv, expected }) => {
    const result = await captureMain(argv);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain('unknown option');
    expect(result.stderr).toContain(expected);
  });

  // The other half of the same rule: once a subcommand is named, an option
  // complaint is about that subcommand and stays Commander's to make.
  it('keeps the unknown-option message once a subcommand is named', async () => {
    const result = await captureMain(['history', 'status', '--nonsense']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown option '--nonsense'");
  });
});

describe('unknown command remedies (P6)', () => {
  it('far misses point at circuit --help', async () => {
    const result = await captureMain(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command 'frobnicate'");
    expect(result.stderr).toContain('circuit --help');
  });

  it('near misses keep the did-you-mean suggestion', async () => {
    const result = await captureMain(['runz']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Did you mean/);
  });
});

describe('--version remedy (P7)', () => {
  it('rejects --version and names the version command', async () => {
    const result = await captureMain(['--version']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown option '--version'");
    expect(result.stderr).toContain('circuit version');
  });
});

describe('root --help (P8)', () => {
  it('prints the same front-door page bare circuit prints in a pipe', async () => {
    const result = await captureMain(['--help']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${renderFrontDoor()}\n`);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('answers -h at the root too', async () => {
    const result = await captureMain(['-h']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${renderFrontDoor()}\n`);
  });
});

describe('front-door doctor listing (P3)', () => {
  it('lists circuit doctor on the orientation page', () => {
    expect(renderFrontDoor()).toContain('circuit doctor');
  });
});
