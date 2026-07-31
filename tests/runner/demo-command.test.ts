// `circuit demo` — the five-minute first run.
//
// Two things have to hold for the demo to be worth pointing a new user at:
// the project it builds must genuinely fail its own test before the run (a
// demo of "it can't skip the proof" is worthless if there is nothing to
// prove), and the run must be aimed at that project rather than at the
// user's checkout.
//
// The Fix run itself is not exercised here — it spends real model budget, and
// the flow's own behavior is covered by the Fix runtime and live-bar suites.
// What these tests pin is the scaffold and the wiring.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runDemoCommand, scaffoldDemoProject } from '../../src/cli/demo.js';
import type { ParsedArgs, RunCommandOptions } from '../../src/cli/run.js';

const tempRoots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'demo-command-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function captureStdout(): { restore: () => string } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    restore: () => {
      (process.stdout as { write: unknown }).write = original;
      return chunks.join('');
    },
  };
}

describe('scaffoldDemoProject', () => {
  it('writes a project whose own test suite fails', () => {
    const dir = join(tempDir(), 'project');
    scaffoldDemoProject(dir);

    const result = spawnSync('npm', ['test'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    // The failing assertion has to name the actual defect, or the demo's
    // implementer has nothing concrete to work from.
    expect(`${result.stdout}${result.stderr}`).toContain('hello-world-');
  });

  it('passes its own test once the documented one-line fix is applied', () => {
    const dir = join(tempDir(), 'project');
    scaffoldDemoProject(dir);
    writeFileSync(
      join(dir, 'src/slugify.js'),
      `export function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`,
      'utf8',
    );

    const result = spawnSync('npm', ['test'], { cwd: dir, encoding: 'utf8' });
    expect(result.status).toBe(0);
  });

  it('commits the project so a run has a baseline to compare against', () => {
    const dir = join(tempDir(), 'project');
    scaffoldDemoProject(dir);

    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
    // A dirty tree at run start is exactly the contamination the change-set
    // writer has to reason about. The demo must not hand it one.
    expect(status).toBe('');
  });
});

describe('runDemoCommand', () => {
  it('runs fix against the demo project, not the current checkout', async () => {
    const dir = join(tempDir(), 'project');
    let seen: { args: ParsedArgs; options: RunCommandOptions } | undefined;
    const capture = captureStdout();
    const exitCode = await runDemoCommand(['--dir', dir], {
      execute: async (args, options) => {
        seen = { args, options };
        return 0;
      },
    });
    const out = capture.restore();

    expect(exitCode).toBe(0);
    expect(seen?.args.flowName).toBe('fix');
    expect(seen?.args.goal).toContain('slugify');
    expect(seen?.options.projectRoot).toBe(dir);
    expect(seen?.options.configCwd).toBe(dir);
    // Cheapest dial by default: the bug is one line, and a first run should
    // not be an expensive one.
    expect(seen?.args.power).toBe('low');
    // The user is told it costs money before the run starts, not after.
    expect(out).toMatch(/real cost/);
    expect(out).toContain(dir);
  });

  it('honors an explicit power dial', async () => {
    const dir = join(tempDir(), 'project');
    let seen: ParsedArgs | undefined;
    const capture = captureStdout();
    await runDemoCommand(['--dir', dir, '--power', 'high'], {
      execute: async (args) => {
        seen = args;
        return 0;
      },
    });
    capture.restore();
    expect(seen?.power).toBe('high');
  });

  it('rejects an unknown power dial without writing anything', async () => {
    const dir = join(tempDir(), 'project');
    const exitCode = await runDemoCommand(['--dir', dir, '--power', 'turbo'], {
      execute: async () => {
        throw new Error('must not run the flow on a usage error');
      },
    });
    expect(exitCode).toBe(2);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses to write the demo project into a directory that already has files', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/mine.ts'), 'export const mine = 1;\n', 'utf8');

    const exitCode = await runDemoCommand(['--dir', dir], {
      execute: async () => {
        throw new Error('must not run the flow when the directory is refused');
      },
    });
    expect(exitCode).toBe(2);
    // The operator's file is untouched.
    expect(readFileSync(join(dir, 'src/mine.ts'), 'utf8')).toBe('export const mine = 1;\n');
  });

  it("carries the run's exit code out and still says where to look", async () => {
    const dir = join(tempDir(), 'project');
    const capture = captureStdout();
    const exitCode = await runDemoCommand(['--dir', dir], { execute: async () => 1 });
    const out = capture.restore();

    expect(exitCode).toBe(1);
    expect(out).toMatch(/did not close clean/);
    expect(out).toContain(dir);
  });
});
