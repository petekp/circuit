// A flow must not decide what a project's toolchain looks like.
//
// Two flows shipped a project command written straight into the flow: Sweep
// assumed `npm run scan` / `npm run audit`, and Explainer assumed
// `npm run build`. Both were unrunnable outside a Node repo that happened to
// expose those exact scripts, and both failed with the package manager's own
// "Missing script" noise rather than naming what to declare. The fix in each
// case was the same: resolve through src/shared/verification-resolver.ts, which
// owns the precedence (inline goal instruction, then .circuit/config.yaml, then
// package scripts) and produces one blocked reason that names the key.
//
// This is the guard that keeps it fixed. It is a source-text audit rather than
// a behavioral one because the defect is static: the literal is visible in the
// flow package, and no test of a Node fixture would ever catch it. A new flow
// that hardcodes a toolchain binary fails here with the resolver named.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const FLOWS_ROOT = join(import.meta.dirname, '..', '..', 'src', 'flows');
const REPO_ROOT = join(import.meta.dirname, '..', '..');

// Binaries that belong to the project being worked on, not to Circuit. Running
// one means asserting what the project's toolchain is.
const PROJECT_TOOLCHAIN_BINARIES = [
  'npm',
  'npx',
  'pnpm',
  'pnpx',
  'yarn',
  'bun',
  'bunx',
  'make',
  'cargo',
  'go',
  'python',
  'python3',
  'pytest',
  'ruff',
  'tsc',
  'eslint',
  'vitest',
  'jest',
] as const;

// A quoted string literal holding exactly one of those binaries. Matches
// `'npm'` and `"npm"` in an argv array; ignores `npm run build` inside prose,
// which is how the comments and docs talk about the defect.
const TOOLCHAIN_LITERAL = new RegExp(`(['"])(${PROJECT_TOOLCHAIN_BINARIES.join('|')})\\1`, 'gu');

// A few of those words are also ordinary vocabulary. `'go'` is a file
// extension as often as it is a command, and a flow that classifies source
// files by extension has to write it down. Each exception names the file and
// the exact words allowed in it, so the same file adding `'npm'` still fails
// and the guard never goes quiet over a whole module.
const ALLOWED_NON_COMMAND_LITERALS: Readonly<Record<string, readonly string[]>> = {
  // The snapshot read-order classifier. Every word here is an entry in a set
  // of file extensions; nothing in the file spawns a process.
  'src/flows/review/writers/snapshot-ranking.ts': ['go'],
};

function typeScriptSourcesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...typeScriptSourcesUnder(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

// Strip line and block comments so the prose explaining a fix does not read as
// the defect it describes.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[\t ]*\/\/.*$/gmu, '');
}

describe('flow packages do not hardcode project toolchain commands', () => {
  it('routes every project command through the verification resolver', () => {
    const offenders: string[] = [];

    for (const path of typeScriptSourcesUnder(FLOWS_ROOT)) {
      const relativePath = relative(REPO_ROOT, path);
      const allowed = ALLOWED_NON_COMMAND_LITERALS[relativePath] ?? [];
      const code = withoutComments(readFileSync(path, 'utf8'));
      for (const match of code.matchAll(TOOLCHAIN_LITERAL)) {
        const binary = match[2] as string;
        if (allowed.includes(binary)) continue;
        const line = code.slice(0, match.index).split('\n').length;
        offenders.push(`${relativePath}:${line} hardcodes '${binary}'`);
      }
    }

    expect(
      offenders,
      [
        'A flow package names a project toolchain binary directly.',
        'Resolve it through src/shared/verification-resolver.ts instead, so the',
        'project can declare its own command in .circuit/config.yaml and an',
        'undeclared project is told which key to set.',
        '',
        ...offenders,
      ].join('\n'),
    ).toEqual([]);
  });

  // An allowance that no longer matches anything is an allowance nobody will
  // notice going stale. Fail on it so the list stays a record of live
  // exceptions rather than a graveyard.
  it('has no allowance for a literal that is no longer there', () => {
    const stale: string[] = [];

    for (const [relativePath, words] of Object.entries(ALLOWED_NON_COMMAND_LITERALS)) {
      const code = withoutComments(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
      const present = new Set([...code.matchAll(TOOLCHAIN_LITERAL)].map((match) => match[2]));
      for (const word of words) {
        if (!present.has(word)) stale.push(`${relativePath} no longer contains '${word}'`);
      }
    }

    expect(
      stale,
      ['Drop these from ALLOWED_NON_COMMAND_LITERALS:', '', ...stale].join('\n'),
    ).toEqual([]);
  });

  // The rule above only bites if the resolver is genuinely the shared route.
  // If this list ever empties, the guard above is passing vacuously.
  it('has flows actually using the resolver', () => {
    const users = typeScriptSourcesUnder(FLOWS_ROOT).filter((path) =>
      readFileSync(path, 'utf8').includes('verification-resolver'),
    );

    expect(users.length).toBeGreaterThanOrEqual(6);
  });
});
