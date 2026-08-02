import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { sha256OfString } from '../../schemas/hashing.js';
import {
  type ProofPlanCommand,
  packageScriptInvocation,
  resolveProjectRelativeProofCwd,
} from '../../shared/proof-plan.js';

// Oracle-command pin (engine change 2 of the Sweep hardening pair).
//
// A judge-gated until-loop re-reads its verification command list from the
// worker-editable run folder on every wave (fix-until-green reads
// `plan.json`; Sweep reads its rescan plan). Two things about that list are
// worker-controllable between waves, and either one can launder a red run
// into a green close:
//
//   1. Command narrowing. The worker edits the plan so the command that ran a
//      real scan on wave 0 now runs a no-op. The argv the executor spawns on
//      wave 1 is whatever the plan says.
//   2. Script-body swap. The argv stays byte-identical (`npm run verify`) but
//      the worker rewrites `package.json`'s `scripts.verify` to an
//      always-green no-op. `npm run <script>` resolves the body at spawn, so
//      the pinned argv alone is a false floor for package-script commands.
//   3. Program rewrite. Both the argv and the script body stay byte-identical
//      (`npm run verify` -> `node scan.mjs`) but the worker neuters scan.mjs,
//      or a helper scan.mjs imports. The body is a launcher, not the program,
//      so fingerprinting the body alone is a false floor for the wrapper-script
//      shape.
//
// The pin closes all three. On the first resolution for a step it snapshots the
// resolved command list, fingerprints every referenced package-script body, AND
// fingerprints the local program closure each command launches. It then serves
// that same snapshot on every later wave (closing vector 1) while re-checking
// every fingerprint and refusing to run if any drifted (closing vectors 2 and
// 3). The channel is created only for runs that already carry an honesty ledger
// (a stop-judge until-loop), so single-pass steps that resolve once are inert —
// they pin, never re-resolve, and never drift-check.
//
// What the program closure covers, stated precisely because a floor that is
// vaguer than its guarantee is worse than no floor: the local files named in
// the argv or the script body, plus everything those files reach through
// STATIC relative import/require specifiers, transitively. It does NOT cover
// programs inside node_modules (a real tsc or ESLint binary), specifiers built
// at run time, or data files the program reads rather than imports.

interface PinnedOracle {
  readonly commands: readonly ProofPlanCommand[];
  // Keyed by command id: the sha256 of the referenced package-script body at
  // pin time. Only commands that invoke `npm|pnpm|yarn run <script>` appear;
  // direct-argv commands (no package indirection) carry no fingerprint because
  // their argv is the whole story and the pin already froze it.
  readonly scriptFingerprints: ReadonlyMap<string, string>;
  // Keyed by command id: project-relative program file -> sha256 at pin time.
  // Empty for a command that launches no local program (`tsc --noEmit`), which
  // is why this is additive: it constrains the wrapper-script shape and leaves
  // every other command exactly as pinned as it was before.
  readonly programFingerprints: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

// Bounds on the closure walk. A scanner is a small program; these caps exist so
// a pathological import graph cannot turn every wave into a tree crawl.
const MAX_PROGRAM_FILES = 200;
const MAX_PROGRAM_FILE_BYTES = 2 * 1024 * 1024;

// Extensions tried when a relative specifier omits one, in Node resolution
// order. Directory specifiers resolve through their index file.
const PROGRAM_EXTENSIONS = ['', '.mjs', '.js', '.cjs', '.mts', '.ts', '.jsx', '.tsx'] as const;
const PROGRAM_INDEX_FILES = ['index.mjs', 'index.js', 'index.cjs', 'index.ts'] as const;

// Static relative import/require specifiers. Anything computed at run time is
// out of reach by construction, which is why the header states the limit.
const RELATIVE_SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.[^'"]*)['"]/g;

// The command cwd resolves through `realpathSync`, so a project root reached by
// a symlink (every macOS `/var/folders` temp dir, and any repo under a symlinked
// parent) is spelled differently from the files under it. Compare and key the
// closure in the same real form, or containment rejects every seed and the
// closure silently comes out empty — a floor that quietly stops holding.
function realProjectRoot(projectRoot: string): string {
  const rootAbs = resolve(projectRoot);
  try {
    return realpathSync.native(rootAbs);
  } catch {
    return rootAbs;
  }
}

function isInsideProject(candidate: string, projectRoot: string): boolean {
  const rel = relative(projectRoot, candidate);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !rel.includes(`..${sep}`);
}

function existingFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// Resolve a relative specifier the way Node would, far enough for the shapes a
// scanner actually uses. Returns undefined when nothing on disk matches, which
// is the honest answer for a bare-module or computed specifier.
function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  for (const extension of PROGRAM_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existingFile(candidate)) return candidate;
  }
  for (const indexFile of PROGRAM_INDEX_FILES) {
    const candidate = join(base, indexFile);
    if (existingFile(candidate)) return candidate;
  }
  return undefined;
}

// A token is a program-path candidate only if it could plausibly BE a path.
// Flags, bare tool names, and inline code (`node -e "…"`) are excluded so the
// closure never latches onto something that merely looks filename-shaped.
function isPathCandidate(token: string): boolean {
  if (token === '' || token.startsWith('-')) return false;
  if (/["'()$`;&|<>]/.test(token)) return false;
  return token.includes('/') || token.includes('.');
}

// Seed files: the local programs a command launches directly, whether named in
// the argv or in the package-script body the argv resolves to.
function seedProgramFiles(
  command: ProofPlanCommand,
  projectRoot: string,
  scriptBody: string | undefined,
): string[] {
  const cwdAbs = resolveProjectRelativeProofCwd(projectRoot, command.cwd);
  const rootReal = realProjectRoot(projectRoot);
  const tokens = [...command.argv, ...(scriptBody === undefined ? [] : scriptBody.split(/\s+/))];
  const seeds: string[] = [];
  for (const token of tokens) {
    if (!isPathCandidate(token)) continue;
    const candidate = resolve(cwdAbs, token);
    if (candidate.includes(`${sep}node_modules${sep}`)) continue;
    if (!isInsideProject(candidate, rootReal)) continue;
    if (!existingFile(candidate)) continue;
    seeds.push(candidate);
  }
  return seeds;
}

// The transitive local closure of a command's programs, as project-relative
// paths mapped to their content hashes.
function fingerprintProgramClosure(
  command: ProofPlanCommand,
  projectRoot: string,
  scriptBody: string | undefined,
): Map<string, string> {
  const fingerprints = new Map<string, string>();
  const rootReal = realProjectRoot(projectRoot);
  const queue = seedProgramFiles(command, projectRoot, scriptBody);
  const seen = new Set<string>();

  while (queue.length > 0 && fingerprints.size < MAX_PROGRAM_FILES) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    let content: string;
    try {
      if (statSync(file).size > MAX_PROGRAM_FILE_BYTES) continue;
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    fingerprints.set(relative(rootReal, file), sha256OfString(content));

    for (const match of content.matchAll(RELATIVE_SPECIFIER_PATTERN)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const resolved = resolveSpecifier(file, specifier);
      if (resolved === undefined) continue;
      if (resolved.includes(`${sep}node_modules${sep}`)) continue;
      if (!isInsideProject(resolved, rootReal)) continue;
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  return fingerprints;
}

export interface OracleCommandPinChannel {
  readonly pins: Map<string, PinnedOracle>;
}

export function createOracleCommandPinChannel(): OracleCommandPinChannel {
  return { pins: new Map() };
}

// Thrown when a pinned package-script body changed between waves. Caught by the
// verification executor's try/catch, which turns it into a step failure so the
// run aborts rather than trusting a rewritten oracle.
export class OracleCommandDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OracleCommandDriftError';
  }
}

// Resolve the body string of the package script a command invokes, or undefined
// if the command is not a package-script invocation. Throws if the script is
// referenced but its package.json cannot be read or the script is missing —
// the same conditions the proof-plan preflight already rejects, surfaced here
// so a pinned script that disappears is a drift, not a silent passthrough.
function readReferencedScriptBody(
  command: ProofPlanCommand,
  projectRoot: string,
): { readonly script: string; readonly body: string } | undefined {
  const script = packageScriptInvocation(command);
  if (script === undefined) return undefined;

  const cwdAbs = resolveProjectRelativeProofCwd(projectRoot, command.cwd);
  const packageJsonPath = join(cwdAbs, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new OracleCommandDriftError(
      `oracle script "${script}" for command '${command.id}' vanished: package.json missing at its cwd`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OracleCommandDriftError(
      `oracle script "${script}" for command '${command.id}' unreadable: ${message}`,
    );
  }
  const scripts =
    parsed && typeof parsed === 'object' ? (parsed as { scripts?: unknown }).scripts : undefined;
  const body =
    scripts && typeof scripts === 'object' && !Array.isArray(scripts)
      ? (scripts as Record<string, unknown>)[script]
      : undefined;
  if (typeof body !== 'string') {
    throw new OracleCommandDriftError(
      `oracle script "${script}" for command '${command.id}' vanished from package.json since the loop entered`,
    );
  }
  return { script, body };
}

function fingerprintCommands(
  commands: readonly ProofPlanCommand[],
  projectRoot: string,
): {
  readonly scriptFingerprints: Map<string, string>;
  readonly programFingerprints: Map<string, Map<string, string>>;
} {
  const scriptFingerprints = new Map<string, string>();
  const programFingerprints = new Map<string, Map<string, string>>();
  for (const command of commands) {
    const referenced = readReferencedScriptBody(command, projectRoot);
    if (referenced !== undefined) {
      scriptFingerprints.set(command.id, sha256OfString(referenced.body));
    }
    programFingerprints.set(
      command.id,
      fingerprintProgramClosure(command, projectRoot, referenced?.body),
    );
  }
  return { scriptFingerprints, programFingerprints };
}

// Serve the same resolved oracle command list for a step across every wave of a
// loop, and reject a drifted package-script body.
//
// First call for `stepId`: run `load()`, fingerprint referenced script bodies,
// cache both, and return the freshly loaded commands. Every later call: ignore
// what `load()` would now return (that is the narrowing vector — never read it),
// re-fingerprint the pinned commands' scripts against the current package.json,
// throw OracleCommandDriftError on any mismatch, and otherwise return the
// pinned commands.
//
// Generic over the command type so a caller passing branded VerificationCommands
// gets branded commands back: pinning is a cache, and passing through a cache
// must not launder away the proof that a command was parsed.
export function resolveOracleCommands<Command extends ProofPlanCommand>(input: {
  readonly channel: OracleCommandPinChannel;
  readonly stepId: string;
  readonly projectRoot: string;
  readonly load: () => readonly Command[];
}): readonly Command[] {
  const { channel, stepId, projectRoot, load } = input;
  const existing = channel.pins.get(stepId);
  if (existing === undefined) {
    const commands = load();
    const { scriptFingerprints, programFingerprints } = fingerprintCommands(commands, projectRoot);
    channel.pins.set(stepId, { commands, scriptFingerprints, programFingerprints });
    return commands;
  }

  // Re-check every pinned script body and program file against what is on disk
  // now. The pinned commands are the source of truth for what runs; `load()` is
  // deliberately not called, so a narrowed plan cannot take effect.
  for (const command of existing.commands) {
    const referenced = readReferencedScriptBody(command, projectRoot);
    const pinnedFingerprint = existing.scriptFingerprints.get(command.id);
    if (pinnedFingerprint !== undefined) {
      // readReferencedScriptBody throws if the script vanished; a defined result
      // with a changed body is the swap vector.
      const currentFingerprint =
        referenced === undefined ? undefined : sha256OfString(referenced.body);
      if (currentFingerprint !== pinnedFingerprint) {
        const scriptName = packageScriptInvocation(command) ?? command.id;
        throw new OracleCommandDriftError(
          `oracle script "${scriptName}" changed since the loop entered; refusing to trust a rewritten verification command`,
        );
      }
    }

    // The program the (unchanged) script launches is the third vector. Compare
    // against the pinned closure rather than recomputing what to trust: a file
    // that vanished from the closure is as much a rewrite as one that changed.
    const pinnedPrograms = existing.programFingerprints.get(command.id);
    if (pinnedPrograms === undefined || pinnedPrograms.size === 0) continue;
    const currentPrograms = fingerprintProgramClosure(command, projectRoot, referenced?.body);
    for (const [file, pinnedHash] of pinnedPrograms) {
      const currentHash = currentPrograms.get(file);
      if (currentHash === pinnedHash) continue;
      throw new OracleCommandDriftError(
        currentHash === undefined
          ? `oracle program "${file}" for command '${command.id}' vanished since the loop entered; refusing to trust a rewritten verification command`
          : `oracle program "${file}" for command '${command.id}' changed since the loop entered; refusing to trust a rewritten verification command`,
      );
    }
  }
  // The channel stores commands as the wider ProofPlanCommand because it is
  // shared across steps with different writers. These are the very objects a
  // prior call to this same stepId returned from `load()`, so they are Command.
  return existing.commands as readonly Command[];
}
