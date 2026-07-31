import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { DEFAULT_AXES } from '../schemas/axes.js';
import { PowerDialSetting } from '../schemas/power.js';
import { commanderErrorMessage, configureCommanderProgram } from './commander-support.js';
import { type ParsedArgs, type RunCommandOptions, runExecutionCommand } from './run.js';
import { colorEnabled, terminalPalette } from './terminal-style.js';

// `circuit demo` — the five-minute first run.
//
// A new user's first Circuit run should end with a moment they can check
// themselves: a command that failed before the run and passes after it, with
// the run's own evidence saying so. Pointing them at their own repository
// cannot promise that. The scope is unbounded, the cost is unpredictable, and
// the safest flow to suggest (Review) is the one that shows the least.
//
// So the demo brings its own subject: a throwaway project with one real bug
// and one failing test, in a fresh directory that is not the user's
// checkout. Fix runs against it for real — a real connector, a real model, a
// real proof chain. Nothing here is replayed or stubbed, because a
// demonstration of "it can't skip the proof" that skipped the proof would be
// the one claim Circuit cannot afford to fake.

const DEMO_GOAL =
  'slugify leaves a trailing dash on any title that ends in punctuation, and the test in ' +
  'test/slugify.test.js fails because of it. Fix slugify so a slug never starts or ends with a dash.';

// The bug: separators collapse to dashes, but the dashes at the ends are never
// trimmed, so 'Hello, World!' becomes 'hello-world-'. One line to fix, and the
// failing assertion says exactly what is wrong. Small enough to be cheap;
// real enough that the fix is a judgement, not a transcription.
const DEMO_FILES: Readonly<Record<string, string>> = {
  'package.json': `${JSON.stringify(
    {
      name: 'circuit-demo',
      version: '0.0.0',
      private: true,
      type: 'module',
      scripts: { test: 'node --test' },
    },
    null,
    2,
  )}\n`,
  'src/slugify.js': `// Turns a title into a URL slug.
export function slugify(title) {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
}
`,
  'test/slugify.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';

import { slugify } from '../src/slugify.js';

test('slugify replaces runs of punctuation and spaces with a single dash', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('Hello,   World'), 'hello-world');
});

test('slugify never leaves a dash at either end', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  ...Draft...  '), 'draft');
});
`,
  'README.md': `# circuit demo project

A throwaway project \`circuit demo\` created so a first Fix run has something
real to fix. \`slugify\` leaves a dash at the end of any title ending in
punctuation, and \`npm test\` fails because of it.

Nothing here is connected to your own work. Delete this directory whenever
you like.
`,
};

interface DemoInvocation {
  readonly dir?: string;
  readonly power: string;
}

function invalid(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return 2;
}

function parseInvocation(argv: readonly string[]): DemoInvocation {
  const program = configureCommanderProgram(new Command('circuit demo'))
    .option('--dir <path>', 'where to create the demo project')
    .option('--power <dial>', 'model dial for the demo run', 'low');
  program.parse([...argv], { from: 'user' });
  const opts = program.opts<{ dir?: string; power: string }>();
  return {
    ...(opts.dir === undefined ? {} : { dir: opts.dir }),
    power: opts.power,
  };
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Circuit Demo',
      GIT_AUTHOR_EMAIL: 'demo@circuit.invalid',
      GIT_COMMITTER_NAME: 'Circuit Demo',
      GIT_COMMITTER_EMAIL: 'demo@circuit.invalid',
    },
  });
}

// Fix compares the working tree against a snapshot taken at run start, so the
// demo project has to be a git repository with a commit behind it. Without
// one there is no baseline to compare against and no honest way to say which
// files the run changed.
export function scaffoldDemoProject(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [relPath, body] of Object.entries(DEMO_FILES)) {
    const fullPath = join(dir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, body, 'utf8');
  }
  git(dir, ['init', '--quiet']);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'demo project with a failing test']);
}

function chooseDemoDir(requested: string | undefined): { dir: string } | { error: string } {
  if (requested === undefined) {
    return { dir: mkdtempSync(join(tmpdir(), 'circuit-demo-')) };
  }
  const dir = resolve(requested);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    return {
      error: `${dir} already has files in it. The demo writes a whole project, so it needs an empty or new directory. Pass --dir with a path that does not exist yet.`,
    };
  }
  return { dir };
}

function writeIntro(dir: string, power: string): void {
  const palette = terminalPalette(colorEnabled());
  process.stdout.write(
    [
      '',
      `${palette.accent('◆')} ${palette.bold('circuit demo')}`,
      '',
      `A demo project is set up at ${palette.bold(dir)}. It has one real bug:`,
      'slugify leaves a dash at the end of any title that ends in punctuation,',
      'and `npm test` fails on it right now.',
      '',
      `Fix will run against that project at the ${palette.bold(power)} power dial. This is a real`,
      'run: a real connector, a real model, and real cost. It usually takes a few',
      'minutes. Nothing outside the demo project is touched.',
      '',
      'What to watch for at the end: Fix records the test failing before the change',
      'and passing after it. That before-and-after is the proof the run cannot skip.',
      '',
      palette.dim('Starting the run.'),
      '',
    ].join('\n'),
  );
}

function writeOutro(dir: string, exitCode: number): void {
  const palette = terminalPalette(colorEnabled());
  const lines = [''];
  if (exitCode === 0) {
    lines.push(
      `${palette.bold('The demo run finished.')} To check it yourself:`,
      '',
      `  cd ${dir} && npm test        ${palette.dim('# the test that was failing')}`,
      `  git -C ${dir} diff           ${palette.dim('# what the run changed')}`,
    );
  } else {
    lines.push(
      `${palette.bold('The demo run did not close clean.')} The run said why above, and its`,
      'evidence is on disk. To see the state it left behind:',
      '',
      `  cd ${dir} && npm test`,
      `  git -C ${dir} diff`,
    );
  }
  lines.push(
    '',
    `The run's own reports are under ${palette.bold(join(dir, '.circuit/runs'))}.`,
    '',
    `Next: ${palette.bold('circuit preview')} shows what any flow would cost before you run it,`,
    `and ${palette.bold('circuit run fix --goal "..."')} points the same flow at your own work.`,
    '',
    palette.dim(`The demo project is yours to keep or delete: rm -rf ${dir}`),
    '',
  );
  process.stdout.write(lines.join('\n'));
}

export interface DemoCommandOptions extends RunCommandOptions {
  // Test seam: run the flow without shelling out to a real connector.
  readonly execute?: (args: ParsedArgs, options: RunCommandOptions) => Promise<number>;
}

export async function runDemoCommand(
  argv: readonly string[],
  options: DemoCommandOptions = {},
): Promise<number> {
  let invocation: DemoInvocation;
  try {
    invocation = parseInvocation(argv);
  } catch (err) {
    return invalid(commanderErrorMessage(err));
  }
  const power = PowerDialSetting.safeParse(invocation.power);
  if (!power.success) {
    return invalid(`--power must be one of auto, low, medium, high (got '${invocation.power}').`);
  }

  const chosen = chooseDemoDir(invocation.dir);
  if ('error' in chosen) return invalid(chosen.error);

  try {
    scaffoldDemoProject(chosen.dir);
  } catch (err) {
    process.stderr.write(
      `error: could not set up the demo project at ${chosen.dir}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }

  writeIntro(chosen.dir, power.data);

  const args: ParsedArgs = {
    command: 'run',
    flowName: 'fix',
    goal: DEMO_GOAL,
    axes: DEFAULT_AXES,
    power: power.data,
    powerProvided: true,
    processProvided: false,
    tournamentProvided: false,
    autonomousProvided: false,
    includeUntrackedContent: false,
  };
  const execute = options.execute ?? runExecutionCommand;
  const exitCode = await execute(args, {
    ...options,
    projectRoot: chosen.dir,
    configCwd: chosen.dir,
  });

  writeOutro(chosen.dir, exitCode);
  return exitCode;
}
