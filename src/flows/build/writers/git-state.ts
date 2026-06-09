#!/usr/bin/env node
// Snapshot the git working tree for the proof-carrying Fix change-set chain.
//
// Used by both fix-baseline-snapshot (pre-fix) and fix-change-set (post-fix).
// The two writers compare snapshots to determine which paths fix-act actually
// touched, which is the spine of the Fix change-set verdict.
//
// Why a helper script instead of letting the writer call git directly?
// Verification writers are limited to a fixed list of VerificationCommand
// invocations declared at loadCommands time; the runtime spawns each one and
// returns observations. Capturing per-file content fingerprints requires a
// dynamic loop ("git status, then git hash-object for every dirty path"),
// which doesn't fit a static command list. A single Node process can do
// both, so the writer just declares one command — this script.
//
// Output (stdout, JSON, exits 0):
//   {
//     head_sha: "<40-hex sha>",
//     entries: [
//       {
//         status_code: "<2 chars>",     // git porcelain XY (e.g. " M", "??", "R ")
//         path: "<destination path>",   // for renames/copies, the new path
//         fingerprint: "<oid|sentinel>",
//         from?: "<source path>"        // only for renames/copies
//       },
//       ...
//     ],
//     hidden_index_flags: [
//       { tag: "<1 char>", path: "<path>" },  // assume-unchanged or skip-worktree
//       ...
//     ]
//   }
//
// fingerprint values:
//   - 40-char hex git OID for files we could `git hash-object` (working-tree
//     blob)
//   - "<deleted>" for paths whose working-tree copy is gone (D status)
//   - "<unhashable:<reason>>" if hash-object failed unexpectedly
//
// On any unrecoverable failure (no git, not a repo, etc.) the script writes a
// short error to stderr and exits 1; the verification executor will surface
// that as a failed observation.

import { execFileSync } from 'node:child_process';
import process from 'node:process';

type GitStateEntry = {
  status_code: string;
  path: string;
  fingerprint: string;
  from?: string;
};

type HiddenIndexFlag = {
  tag: string;
  path: string;
};

function git(args: readonly string[]): string {
  // Buffer cap is generous — repos with thousands of dirty paths still fit.
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 50_000_000,
  });
}

function gitBytes(args: readonly string[]): Buffer {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    maxBuffer: 50_000_000,
  });
}

function fail(message: string): never {
  process.stderr.write(`fix-git-state: ${message}\n`);
  process.exit(1);
}

let head: string;
try {
  head = git(['rev-parse', 'HEAD']).trim();
} catch (err) {
  fail(`git rev-parse HEAD failed: ${err instanceof Error ? err.message : String(err)}`);
}

let statusBuf: Buffer;
try {
  // Porcelain v1 with -z null-delimited entries and --untracked-files=all so
  // expanded directories ("?? dir/") become per-file entries we can fingerprint
  // and that adversaries can't hide under a directory bucket.
  statusBuf = gitBytes(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
} catch (err) {
  fail(`git status failed: ${err instanceof Error ? err.message : String(err)}`);
}

// Parse -z null-delimited entries.
//   Plain entry: 'XY <path>\0'
//   Rename/copy: 'XY <new-path>\0<old-path>\0'
const entries: GitStateEntry[] = [];
{
  const text = statusBuf.toString('utf8');
  let i = 0;
  while (i < text.length) {
    if (text.length - i < 4) break; // need at least "XY <ch>"
    const code = text.slice(i, i + 2);
    i += 2;
    if (text[i] !== ' ') {
      // Malformed line — skip until next null.
      const next = text.indexOf('\0', i);
      i = next === -1 ? text.length : next + 1;
      continue;
    }
    i += 1; // space
    const endA = text.indexOf('\0', i);
    if (endA === -1) break;
    const path = text.slice(i, endA);
    i = endA + 1;

    let fromPath: string | undefined;
    const statusKind = code[0];
    const isRenameOrCopy = statusKind === 'R' || statusKind === 'C';
    if (isRenameOrCopy) {
      const endB = text.indexOf('\0', i);
      if (endB === -1) break;
      fromPath = text.slice(i, endB);
      i = endB + 1;
    }

    let fingerprint: string;
    const isDeleted = code.includes('D');
    if (isDeleted) {
      fingerprint = '<deleted>';
    } else {
      try {
        fingerprint = git(['hash-object', '--', path]).trim();
      } catch (err) {
        const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
        fingerprint = `<unhashable:${reason}>`;
      }
    }

    const entry: GitStateEntry = { status_code: code, path, fingerprint };
    if (fromPath !== undefined) entry.from = fromPath;
    entries.push(entry);
  }
}

// Detect paths flagged with assume-unchanged or skip-worktree, which suppress
// `git status` reporting. An adversary can hide tracked edits this way; the
// change-set writer fails closed when this list is non-empty.
const hiddenIndexFlags: HiddenIndexFlag[] = [];
try {
  const lsFiles = git(['ls-files', '-v']);
  for (const line of lsFiles.split('\n')) {
    if (line.length < 2) continue;
    const tag = line[0];
    if (tag === undefined) continue;
    const rest = line.slice(2);
    // Per `git ls-files -v`: lowercase tags mean assume-unchanged or
    // skip-worktree variants; uppercase means normal cached/etc.
    if (tag !== tag.toLowerCase()) continue;
    if (tag === ' ') continue;
    hiddenIndexFlags.push({ tag, path: rest });
  }
} catch {
  // ls-files -v is best-effort; if it fails (e.g., bare repo), record nothing
  // rather than aborting. The other checks are still in force.
}

process.stdout.write(
  JSON.stringify({ head_sha: head, entries, hidden_index_flags: hiddenIndexFlags }),
);
