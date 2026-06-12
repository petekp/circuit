// Doc command claims — positive validation of every `circuit run` /
// `/circuit:run` invocation that living docs teach, checked against
// imported truth instead of retyped registries:
//
// - flow positionals must be real catalog flow ids (`src/flows/catalog.ts`),
//   which permanently locks out the flowless `circuit run --goal` claim
//   class (the CLI rejects it; see tests/runner/cli-router.test.ts);
// - every `--flag` must exist in RUN_EXECUTION_FLAGS
//   (`src/cli/run-flag-vocabulary.ts`) with docValid true, so a flag
//   rename or removal fails here with zero registry maintenance, and a
//   doc can never teach the hard-rejected `--dry-run`.
//
// The scan is loud-on-empty: floors below assert the scanner keeps
// finding roughly the invocation population that exists today, so a
// scope or parser regression cannot silently turn this into a vacuous
// pass.
//
// Escape hatch: a line containing `<!-- cmd-ok -->` (on the invocation
// line or the line directly above it) exempts that line from
// validation. Use it only for deliberately-negative examples, e.g. a
// doc explaining that flowless `circuit run --goal` is rejected.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RUN_EXECUTION_FLAGS } from '../../src/cli/run-flag-vocabulary.js';
import { catalogFlowIds } from '../../src/flows/catalog.js';

// Living-doc scope, hardcoded for now. This list migrates to
// docs/doc-classes.json (read via scripts/docs/) once the doc-classes
// registry lands; until then it is the single place the lint's reach is
// declared. Patterns support `*` within a path segment and a `**`
// segment for recursive descent.
// biome-ignore lint/suspicious/noExportsInTest: deliberate seam — this scope list is exported so the doc-classes migration can lift it without re-deriving the reach
export const LIVING_DOC_SCOPE = [
  'README.md',
  'AGENTS.md',
  'docs/operator-guide.md',
  'docs/first-run.md',
  'docs/contracts/**/*.md',
  // Dated notes (YYYY-MM-DD-*.md) are point-in-time records, not living
  // docs; the dated-basename filter below excludes them.
  'docs/flows/*.md',
  'src/commands/*.md',
  'src/flows/*/command.md',
  'src/flows/*/contract.md',
  'plugins/*/README.md',
  'plugins/*/commands/*.md',
  '.claude/skills/circuit-surface-test/**/*.md',
] as const;

const ESCAPE_HATCH = '<!-- cmd-ok -->';
const DATED_BASENAME = /^\d{4}-\d{2}-\d{2}/;

// Loud-on-empty floors. Set just below the population counted at
// authoring time (2026-06-12: 29 CLI-form, 20 slash-form) so a scanner
// or scope regression that silently drops a chunk of the population
// fails here rather than passing vacuously.
const CLI_INVOCATION_FLOOR = 25;
const SLASH_INVOCATION_FLOOR = 16;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listDirectory(path: string): readonly string[] {
  try {
    return readdirSync(path === '' ? '.' : path);
  } catch {
    return [];
  }
}

function segmentToRegExp(segment: string): RegExp {
  const escaped = segment
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

function expandSegments(base: string, segments: readonly string[]): string[] {
  if (segments.length === 0) return isFile(base) ? [base] : [];
  const [head, ...rest] = segments;
  if (head === undefined) return [];
  if (head === '**') {
    // `**` matches zero or more directory levels.
    const matches = expandSegments(base, rest);
    for (const entry of listDirectory(base)) {
      const child = base === '' ? entry : join(base, entry);
      if (isDirectory(child)) matches.push(...expandSegments(child, segments));
    }
    return matches;
  }
  if (head.includes('*')) {
    const pattern = segmentToRegExp(head);
    const matches: string[] = [];
    for (const entry of listDirectory(base)) {
      if (!pattern.test(entry)) continue;
      matches.push(...expandSegments(base === '' ? entry : join(base, entry), rest));
    }
    return matches;
  }
  return expandSegments(base === '' ? head : join(base, head), rest);
}

function resolveLivingDocs(): readonly string[] {
  const files = new Set<string>();
  for (const pattern of LIVING_DOC_SCOPE) {
    for (const file of expandSegments('', pattern.split('/'))) {
      const basename = file.split('/').at(-1) ?? file;
      if (DATED_BASENAME.test(basename)) continue;
      files.add(file);
    }
  }
  return [...files].sort();
}

// Shell-style tokenizer: honors single/double quotes (so
// `--goal "multi word"` survives as one value token) and backslash
// escapes outside single quotes. An unterminated quote swallows the
// rest of the text into one token, which is safe for this lint: it can
// hide a flag inside free text, never invent one.
function tokenizeCommandText(text: string): readonly string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  const push = () => {
    if (current.length > 0) tokens.push(current);
    current = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      if (i < text.length) current += text.charAt(i);
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return tokens;
}

interface CommandText {
  readonly line: number;
  readonly text: string;
}

// Extract candidate command texts from one document: every line of a
// fenced code block (with trailing-backslash continuations joined, so
// multi-line shell commands validate as one invocation) and every
// inline code span outside fences. A span left open at the end of a
// line (inline code wrapped across lines) is included from the opening
// backtick to the line end.
function extractCommandTexts(lines: readonly string[]): readonly CommandText[] {
  const texts: CommandText[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const startLine = i + 1;
      let joined = line;
      while (joined.endsWith('\\') && i + 1 < lines.length) {
        joined = `${joined.slice(0, -1)} ${lines[i + 1] ?? ''}`;
        i += 1;
      }
      texts.push({ line: startLine, text: joined });
      continue;
    }
    // Outside fences, odd-indexed splits on ` are inline code spans;
    // when the line has an odd number of backticks the final span is
    // unterminated and still included.
    const parts = line.split('`');
    for (let part = 1; part < parts.length; part += 2) {
      const span = parts[part];
      if (span !== undefined && span.length > 0) texts.push({ line: i + 1, text: span });
    }
  }
  return texts;
}

interface RunInvocation {
  readonly doc: string;
  readonly line: number;
  readonly text: string;
  readonly form: 'cli' | 'slash';
  /** Tokens after `circuit run` / `/circuit:run`. */
  readonly args: readonly string[];
  readonly exempt: boolean;
}

function isCircuitBinaryToken(token: string): boolean {
  return token === 'circuit' || token.endsWith('/circuit');
}

function findRunInvocations(doc: string): readonly RunInvocation[] {
  const lines = readFileSync(doc, 'utf8').split('\n');
  const exemptLines = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!(lines[i] ?? '').includes(ESCAPE_HATCH)) continue;
    exemptLines.add(i + 1);
    exemptLines.add(i + 2);
  }
  const invocations: RunInvocation[] = [];
  for (const candidate of extractCommandTexts(lines)) {
    const tokens = tokenizeCommandText(candidate.text);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === undefined) continue;
      const base = { doc, line: candidate.line, text: candidate.text.trim() };
      const exempt = exemptLines.has(candidate.line);
      if (isCircuitBinaryToken(token) && tokens[i + 1] === 'run') {
        invocations.push({ ...base, form: 'cli', args: tokens.slice(i + 2), exempt });
        i += 1;
        continue;
      }
      if (token === '/circuit:run' && tokens.length > i + 1) {
        invocations.push({ ...base, form: 'slash', args: tokens.slice(i + 1), exempt });
      }
    }
  }
  return invocations;
}

const flagRowsByName = new Map(RUN_EXECUTION_FLAGS.map((row) => [row.flag, row]));
const knownFlowIds = new Set(catalogFlowIds);

function isPlaceholderToken(token: string): boolean {
  return token.includes('<') && token.includes('>');
}

function flagViolation(token: string): string | undefined {
  const name = token.split('=')[0] ?? token;
  const row = flagRowsByName.get(name);
  if (row === undefined) return `unknown flag ${name} (not in RUN_EXECUTION_FLAGS)`;
  if (!row.docValid) return `doc teaches rejected flag ${name}`;
  return undefined;
}

// CLI form: the first positional after `run` must be a catalog flow id
// (or a `<placeholder>`), and every flag must be a doc-valid vocabulary
// flag. `--help` invocations run no flow and are skipped.
function validateCliInvocation(invocation: RunInvocation): readonly string[] {
  if (invocation.args.includes('--help')) return [];
  const violations: string[] = [];
  let positional: string | undefined;
  for (let i = 0; i < invocation.args.length; i++) {
    const token = invocation.args[i];
    if (token === undefined) continue;
    if (token.startsWith('--')) {
      const violation = flagViolation(token);
      if (violation !== undefined) violations.push(violation);
      // A value-taking flag consumes the next token unless written as
      // --flag=value.
      if (flagRowsByName.get(token)?.valueHint !== undefined) i += 1;
      continue;
    }
    // Stop at shell chaining; anything past `&&`/`|`/`;` is a new command.
    if (token === '&&' || token === '||' || token === '|' || token === ';') break;
    if (positional === undefined) positional = token;
  }
  if (positional === undefined) {
    violations.push('missing flow positional (flowless `circuit run` claims are rejected)');
  } else if (!isPlaceholderToken(positional) && !knownFlowIds.has(positional)) {
    violations.push(`unknown flow '${positional}' (not a src/flows/catalog.ts flow id)`);
  }
  return violations;
}

// Slash form: `/circuit:run` takes free text the host routes, so there
// is no positional rule; but any `--flag` it teaches must still be a
// doc-valid vocabulary flag.
function validateSlashInvocation(invocation: RunInvocation): readonly string[] {
  const violations: string[] = [];
  for (const token of invocation.args) {
    if (!token.startsWith('--')) continue;
    const violation = flagViolation(token);
    if (violation !== undefined) violations.push(violation);
  }
  return violations;
}

function describeViolations(
  invocations: readonly RunInvocation[],
  validate: (invocation: RunInvocation) => readonly string[],
): readonly string[] {
  const failures: string[] = [];
  for (const invocation of invocations) {
    if (invocation.exempt) continue;
    for (const violation of validate(invocation)) {
      failures.push(`${invocation.doc}:${invocation.line}: \`${invocation.text}\` — ${violation}`);
    }
  }
  return failures;
}

const livingDocs = resolveLivingDocs();
const allInvocations = livingDocs.flatMap((doc) => [...findRunInvocations(doc)]);
const cliInvocations = allInvocations.filter((invocation) => invocation.form === 'cli');
const slashInvocations = allInvocations.filter((invocation) => invocation.form === 'slash');

describe('doc command claims', () => {
  it('resolves the living-doc scope to real files (loud-on-empty)', () => {
    // Every non-wildcard scope entry must exist; a rename must update
    // the scope list, not silently shrink the lint's reach.
    const missing = LIVING_DOC_SCOPE.filter(
      (pattern) => !pattern.includes('*') && !isFile(pattern),
    );
    expect(missing, 'scope lists a literal doc path that does not exist').toEqual([]);
    expect(
      livingDocs.length,
      'living-doc scope resolved to suspiciously few files — pattern expansion is likely broken',
    ).toBeGreaterThanOrEqual(20);
  });

  it('finds the expected population of run invocations (loud-on-empty)', () => {
    expect(
      cliInvocations.length,
      'CLI `circuit run` invocation count fell below the floor — the scanner or doc scope regressed',
    ).toBeGreaterThanOrEqual(CLI_INVOCATION_FLOOR);
    expect(
      slashInvocations.length,
      '`/circuit:run` invocation count fell below the floor — the scanner or doc scope regressed',
    ).toBeGreaterThanOrEqual(SLASH_INVOCATION_FLOOR);
  });

  it('every CLI `circuit run` claim names a real flow and uses real, doc-valid flags', () => {
    expect(describeViolations(cliInvocations, validateCliInvocation)).toEqual([]);
  });

  it('every `/circuit:run` claim uses only real, doc-valid flags', () => {
    expect(describeViolations(slashInvocations, validateSlashInvocation)).toEqual([]);
  });

  it('the flag vocabulary itself stays well-formed', () => {
    // Anti-vacuity for the imported truth: unique long-form flags, and
    // the known hard-rejected flag stays unteachable.
    const names = RUN_EXECUTION_FLAGS.map((row) => row.flag);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^--[a-z][a-z-]*$/);
    expect(flagRowsByName.get('--dry-run')?.docValid).toBe(false);
  });
});
