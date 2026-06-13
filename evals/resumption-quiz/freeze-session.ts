#!/usr/bin/env node
// Freezes one real host session into an immutable bundle under
// sessions/<session-id>/ so ground truth, arm materials, and runs all read
// from the same bytes. Freezing is step one of the provenance chain: the
// transcript hash recorded here is what generate-quiz must reproduce and what
// build-arm-materials checks before writing any arm artifact.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson } from '../../scripts/evals/shared/json.ts';
import { commandOutput } from '../../scripts/evals/shared/process.ts';
import { type BundleManifest, type FreezeTimeGit, bundleLayout } from './shared/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_SESSIONS_ROOT = resolve(__dirname, 'sessions');

export interface FreezeArgs {
  sessionId: string;
  transcriptPath: string;
  projectRoot: string;
  outDir: string;
  dryRun: boolean;
}

export interface FreezeDeps {
  now?: () => Date;
  gitProbe?: (projectRoot: string) => FreezeTimeGit;
}

function usage(): string {
  return `Usage:
  node evals/resumption-quiz/freeze-session.ts \\
    --session-id <id> \\
    [--project-root <dir>] \\
    [--transcript <path>] \\
    [--out <dir>] \\
    [--dry-run]

Snapshots one host session into sessions/<session-id>/: a byte copy of the
transcript, a copy of <project-root>/.circuit/continuity, and bundle.json with
the transcript sha256 and freeze-time git facts.

--project-root defaults to the current directory.
--transcript defaults to the Claude Code transcript location for the project
  root and session id (~/.claude/projects/<munged-root>/<session-id>.jsonl).
--out defaults to evals/resumption-quiz/sessions (the bundle lands in a
  <session-id> subdirectory).
`;
}

// The host writes transcripts under a directory named after the project root
// with every non-alphanumeric character collapsed to '-'. The synthetic
// fixture's ambient record shows the same shape:
// /Users/synthetic/projects/parse-config -> -Users-synthetic-projects-parse-config.
export function defaultTranscriptPath(projectRoot: string, sessionId: string): string {
  const munged = resolve(projectRoot).replace(/[^a-zA-Z0-9]/g, '-');
  return join(homedir(), '.claude', 'projects', munged, `${sessionId}.jsonl`);
}

export function parseFreezeArgs(argv: string[]): FreezeArgs {
  let sessionId: string | undefined;
  let transcriptPath: string | undefined;
  let projectRoot = process.cwd();
  let outDir = DEFAULT_SESSIONS_ROOT;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === '--session-id') {
      sessionId = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--transcript') {
      transcriptPath = resolve(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--project-root') {
      projectRoot = resolve(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--out') {
      outDir = resolve(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }

  if (sessionId === undefined) {
    throw new Error('--session-id is required');
  }
  // The session id becomes the bundle directory name; reject anything that
  // could escape outDir or produce an unusable path segment.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) || sessionId.includes('..')) {
    throw new Error(
      `--session-id must be a safe path segment (letters, digits, dot, dash, underscore): ${sessionId}`,
    );
  }

  return {
    sessionId,
    transcriptPath: transcriptPath ?? defaultTranscriptPath(projectRoot, sessionId),
    projectRoot,
    outDir,
    dryRun,
  };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function defaultFreezeGitProbe(projectRoot: string): FreezeTimeGit {
  const branch = commandOutput('git', ['rev-parse', '--abbrev-ref', 'HEAD'], '', {
    cwd: projectRoot,
  });
  const head = commandOutput('git', ['rev-parse', 'HEAD'], '', { cwd: projectRoot });
  const git: FreezeTimeGit = {
    status_short: commandOutput('git', ['status', '--short'], '', { cwd: projectRoot }),
  };
  // Detached HEAD reports the literal 'HEAD'; record no branch in that case so
  // the arm builder's stub probe never invents one.
  if (branch !== '' && branch !== 'HEAD') git.branch = branch;
  if (head !== '') git.head = head;
  return git;
}

function continuityRecordStems(continuityDir: string): string[] {
  const recordsDir = join(continuityDir, 'records');
  if (!existsSync(recordsDir)) return [];
  return readdirSync(recordsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort((a, b) => a.localeCompare(b));
}

export function freezeSession(args: FreezeArgs, deps: FreezeDeps = {}): BundleManifest {
  const now = deps.now ?? (() => new Date());
  const gitProbe = deps.gitProbe ?? defaultFreezeGitProbe;

  if (!existsSync(args.transcriptPath)) {
    throw new Error(`transcript not found: ${args.transcriptPath}`);
  }
  if (!existsSync(args.projectRoot)) {
    throw new Error(`project root not found: ${args.projectRoot}`);
  }

  const bundleDir = resolve(args.outDir, args.sessionId);
  const layout = bundleLayout(bundleDir);
  // Refreezing over an existing bundle would silently invalidate a quiz that
  // recorded the old transcript hash; force the operator to delete the bundle
  // (and its derived quiz and arms) first.
  if (existsSync(layout.bundle_json)) {
    throw new Error(
      `bundle already exists at ${bundleDir}; delete it to refreeze (its quiz and arms derive from the old bytes)`,
    );
  }

  const transcriptBytes = readFileSync(args.transcriptPath);
  const continuitySource = join(args.projectRoot, '.circuit', 'continuity');

  const manifest: BundleManifest = {
    schema_version: 1,
    session_id: args.sessionId,
    project_root: resolve(args.projectRoot),
    frozen_at: now().toISOString(),
    transcript_sha256: createHash('sha256').update(transcriptBytes).digest('hex'),
    transcript_bytes: transcriptBytes.byteLength,
    continuity_records_present: continuityRecordStems(continuitySource),
    freeze_time_git: gitProbe(resolve(args.projectRoot)),
  };

  if (args.dryRun) return manifest;

  mkdirSync(layout.source_dir, { recursive: true });
  writeFileSync(layout.transcript, transcriptBytes);
  // The continuity dir always exists in a bundle, even when the project had
  // none, so downstream copies never special-case its absence.
  mkdirSync(layout.continuity_dir, { recursive: true });
  if (existsSync(continuitySource)) {
    cpSync(continuitySource, layout.continuity_dir, { recursive: true });
  }
  writeJson(layout.bundle_json, manifest);
  return manifest;
}

function main(): void {
  const args = parseFreezeArgs(process.argv.slice(2));
  const manifest = freezeSession(args);
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(
      `Dry run only. Would freeze into ${resolve(args.outDir, args.sessionId)}\n`,
    );
    return;
  }
  process.stdout.write(
    `Frozen session ${manifest.session_id} into ${resolve(args.outDir, args.sessionId)}\n`,
  );
  process.stdout.write(
    `transcript sha256 ${manifest.transcript_sha256} (${manifest.transcript_bytes} bytes), ` +
      `${manifest.continuity_records_present.length} continuity record(s)\n`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    __filename === resolve(process.argv[1]) ||
    import.meta.url.endsWith(process.argv[1].split('/').pop() ?? ''));

if (invokedDirectly) {
  try {
    main();
  } catch (error: unknown) {
    process.stderr.write(
      `freeze-session failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
