import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { HostKind, type HostKind as HostKindValue } from '../schemas/host.js';
import { writeTextAtomic } from '../shared/atomic-io.js';
import { parseCommanderOrThrow } from './commander-support.js';
import { CIRCUIT_HOST_KIND_ENV } from './run.js';

// circuit uninstall — clean removal utility (CLI-only).
//
// Install flows add a marker-delimited block to a project's agent
// instructions file (AGENTS.md / CLAUDE.md) that tells agents to start
// every coding task with Circuit. Removing the plugin without removing
// that block leaves a dangling instruction in every future session.
// This command strips the block deterministically and prints the
// host-side plugin-removal commands.
//
// It is intentionally NOT a published /circuit:* host command: uninstall
// is a once-per-lifetime action, and surfacing it in the /circuit palette
// would clutter every routine invocation. The docs point operators here.

// The sentinel markers the install flows write. Kept here as the single
// runtime source; the doc (src/commands/uninstall.md) and the install
// prompt describe the same pair in prose.
export const CIRCUIT_BLOCK_START_MARKER = '<!-- circuit:start -->';
export const CIRCUIT_BLOCK_END_MARKER = '<!-- circuit:end -->';

// Match a marker line tolerantly: any leading/trailing whitespace and any
// internal spacing inside the comment. This survives a reformatter that
// reflows the install block (e.g. prettier normalizing comment spacing).
const START_LINE = /^\s*<!--\s*circuit:start\s*-->\s*$/;
const END_LINE = /^\s*<!--\s*circuit:end\s*-->\s*$/;

// Files that may carry the install block, in report order.
export const UNINSTALL_TARGET_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

export interface StrippedBlock {
  // 1-based line numbers of the start and end marker lines in the ORIGINAL
  // file, for human-readable reporting.
  readonly startLine: number;
  readonly endLine: number;
}

export interface StripResult {
  readonly changed: boolean;
  readonly content: string;
  readonly blocks: readonly StrippedBlock[];
  readonly malformed: boolean;
  readonly malformations: readonly string[];
}

// Pure, side-effect-free block stripper. Removes every well-formed
// `circuit:start … circuit:end` block (inclusive) plus one immediately
// preceding blank line, so the surrounding file is left without a scar.
//
// A block is well-formed only as an exact start→end pair with no marker
// line in between. Any imbalance — an unterminated start, a stray end, or
// a nested start — is malformed: the function reports it and returns the
// content UNCHANGED so the caller can refuse to write rather than guess at
// a corrupted file's intent.
export function stripCircuitBlock(content: string): StripResult {
  const hadTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  // A trailing newline yields a final '' element; drop it for line
  // processing and restore the newline when rejoining.
  if (hadTrailingNewline) lines.pop();

  const out: string[] = [];
  const blocks: StrippedBlock[] = [];
  const malformations: string[] = [];
  // Fail fast on the first malformation. A file with broken markers needs
  // hand repair regardless, and the first imbalance is the actionable one;
  // continuing the forward scan past it would have to guess where the next
  // valid block starts, which is exactly the guessing we refuse to do. The
  // `malformations` array stays plural so the report shape is stable if a
  // future caller ever pre-validates and accumulates.
  const malformed = (reason: string): StripResult => {
    malformations.push(reason);
    return { changed: false, content, blocks: [], malformed: true, malformations };
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (END_LINE.test(line)) {
      return malformed(`stray circuit:end at line ${i + 1} with no matching circuit:start`);
    }
    if (!START_LINE.test(line)) {
      out.push(line);
      i += 1;
      continue;
    }

    // Found a start marker at line i. Scan forward for the matching end,
    // rejecting any nested start before it.
    let j = i + 1;
    let endIndex = -1;
    while (j < lines.length) {
      const candidate = lines[j] ?? '';
      if (START_LINE.test(candidate)) {
        return malformed(
          `nested circuit:start at line ${j + 1} before the block opened at line ${i + 1} closed`,
        );
      }
      if (END_LINE.test(candidate)) {
        endIndex = j;
        break;
      }
      j += 1;
    }
    if (endIndex === -1) {
      return malformed(`unterminated circuit:start at line ${i + 1} (no circuit:end follows)`);
    }

    // Drop one preceding blank line so removing an embedded block does not
    // leave a double blank line behind.
    if (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') {
      out.pop();
    }
    blocks.push({ startLine: i + 1, endLine: endIndex + 1 });
    i = endIndex + 1;
  }

  if (blocks.length === 0) {
    return { changed: false, content, blocks: [], malformed: false, malformations: [] };
  }

  let next = out.join('\n');
  // Restore a single trailing newline only when the file had one and still
  // has content; an emptied file becomes ''.
  if (hadTrailingNewline && next.length > 0) next += '\n';
  return { changed: next !== content, content: next, blocks, malformed: false, malformations };
}

interface UninstallArgs {
  readonly dir: string;
  readonly json: boolean;
}

export interface UninstallMainOptions {
  readonly cwd?: string;
  readonly hostKind?: HostKindValue;
}

function parseArgs(argv: readonly string[], cwd: string): UninstallArgs {
  const program = new Command('circuit uninstall').option('--dir <path>').option('--json');
  parseCommanderOrThrow(program, argv);
  if (program.args.length > 0) throw new Error(`unexpected argument: ${program.args[0]}`);
  const opts = program.opts<{ dir?: string; json?: boolean }>();
  return {
    dir: resolve(opts.dir ?? cwd),
    json: opts.json === true,
  };
}

function resolveHostKind(options: UninstallMainOptions): HostKindValue | undefined {
  if (options.hostKind !== undefined) return options.hostKind;
  const raw = process.env[CIRCUIT_HOST_KIND_ENV];
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    return HostKind.parse(raw);
  } catch {
    return undefined;
  }
}

interface HostRemoval {
  readonly host_kind: HostKindValue | 'unknown';
  readonly commands: readonly string[];
  readonly note?: string;
}

const CLAUDE_REMOVAL = [
  'claude plugin uninstall circuit@circuit',
  'claude plugin marketplace remove circuit',
];
const CODEX_REMOVAL = ['codex plugin marketplace remove circuit'];

function hostRemoval(hostKind: HostKindValue | undefined): HostRemoval {
  if (hostKind === 'claude-code') {
    return {
      host_kind: 'claude-code',
      commands: CLAUDE_REMOVAL,
      note: 'The running session keeps Circuit commands until you restart or reload plugins.',
    };
  }
  if (hostKind === 'codex') {
    return { host_kind: 'codex', commands: CODEX_REMOVAL };
  }
  // generic-shell or unset: the runtime cannot tell which host installed
  // Circuit, so list both and let the operator pick.
  return {
    host_kind: hostKind ?? 'unknown',
    commands: [...CLAUDE_REMOVAL, ...CODEX_REMOVAL],
    note: 'Host unknown — run the commands for whichever host you installed Circuit into.',
  };
}

type FileStatus = 'stripped' | 'no-block' | 'absent' | 'malformed';

interface FileResult {
  readonly file: string;
  readonly path: string;
  readonly status: FileStatus;
  readonly removed_blocks?: number;
  readonly blocks?: readonly StrippedBlock[];
  readonly malformations?: readonly string[];
}

function blockRanges(blocks: readonly StrippedBlock[]): string {
  return blocks
    .map((b) => (b.startLine === b.endLine ? `${b.startLine}` : `${b.startLine}–${b.endLine}`))
    .join(', ');
}

function renderHuman(
  files: readonly FileResult[],
  removal: HostRemoval,
  malformedAny: boolean,
  strippedAny: boolean,
): string {
  const lines: string[] = [];
  for (const f of files) {
    if (f.status === 'stripped') {
      const ranges = blockRanges(f.blocks ?? []);
      lines.push(
        `✓ Removed Circuit block from ${f.file} (lines ${ranges}, circuit:start…circuit:end)`,
      );
    } else if (f.status === 'no-block') {
      lines.push(`• ${f.file}: no Circuit block found, left untouched`);
    } else if (f.status === 'absent') {
      lines.push(`• ${f.file}: not present`);
    } else {
      lines.push(`✗ ${f.file}: malformed Circuit markers — left untouched`);
      for (const m of f.malformations ?? []) lines.push(`    ${m}`);
    }
  }
  if (!strippedAny && !malformedAny) {
    lines.push('No Circuit instruction block found in this project.');
  }
  lines.push('');
  lines.push('Next, remove the plugin from your host:');
  for (const c of removal.commands) lines.push(`  ${c}`);
  if (removal.note !== undefined) {
    lines.push('');
    lines.push(removal.note);
  }
  if (malformedAny) {
    lines.push('');
    lines.push(
      'One or more files had malformed Circuit markers and were left untouched. Fix the markers by hand, then rerun, or remove the block manually.',
    );
  }
  return lines.join('\n');
}

export async function runUninstallCommand(
  argv: readonly string[],
  options: UninstallMainOptions = {},
): Promise<number> {
  let args: UninstallArgs;
  try {
    args = parseArgs(argv, options.cwd ?? process.cwd());
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }

  const files: FileResult[] = [];
  let malformedAny = false;
  let strippedAny = false;

  for (const file of UNINSTALL_TARGET_FILES) {
    const path = join(args.dir, file);
    if (!existsSync(path)) {
      files.push({ file, path, status: 'absent' });
      continue;
    }
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (err) {
      // An unreadable target is an error worth surfacing, not a silent skip.
      process.stderr.write(`error: could not read ${path}: ${(err as Error).message}\n`);
      return 1;
    }
    const result = stripCircuitBlock(content);
    if (result.malformed) {
      malformedAny = true;
      files.push({ file, path, status: 'malformed', malformations: result.malformations });
      continue;
    }
    if (!result.changed) {
      files.push({ file, path, status: 'no-block' });
      continue;
    }
    try {
      // Atomic write: stage to a sibling temp file and rename over the
      // target so a crash mid-write can never leave the user's agent
      // instructions truncated or empty.
      writeTextAtomic(path, result.content);
    } catch (err) {
      process.stderr.write(`error: could not write ${path}: ${(err as Error).message}\n`);
      return 1;
    }
    strippedAny = true;
    files.push({
      file,
      path,
      status: 'stripped',
      removed_blocks: result.blocks.length,
      blocks: result.blocks,
    });
  }

  const removal = hostRemoval(resolveHostKind(options));
  const status = malformedAny ? 'attention' : strippedAny ? 'removed' : 'clean';

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema_version: 1,
          action: 'uninstall',
          status,
          dir: args.dir,
          files: files.map((f) => ({
            file: f.file,
            path: f.path,
            status: f.status,
            ...(f.removed_blocks === undefined ? {} : { removed_blocks: f.removed_blocks }),
            ...(f.blocks === undefined ? {} : { blocks: f.blocks }),
            ...(f.malformations === undefined ? {} : { malformations: f.malformations }),
          })),
          host_removal: removal,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${renderHuman(files, removal, malformedAny, strippedAny)}\n`);
  }

  return malformedAny ? 1 : 0;
}
