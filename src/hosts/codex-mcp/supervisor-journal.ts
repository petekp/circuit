import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  type ExitJournal,
  ExitJournalV1,
  MAX_SUPERVISOR_MESSAGE_BYTES,
  type RuntimeJournal,
  RuntimeJournalV1,
} from './supervisor-protocol.js';

export class SupervisorJournalError extends Error {
  readonly code = 'supervisor_journal_corrupt' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SupervisorJournalError';
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function assertPrivateCanonicalDirectory(path: string): void {
  let direct: ReturnType<typeof lstatSync>;
  try {
    direct = lstatSync(path);
  } catch {
    throw new SupervisorJournalError('The supervisor control directory is unavailable.');
  }
  if (direct.isSymbolicLink() || !direct.isDirectory() || realpathSync.native(path) !== path) {
    throw new SupervisorJournalError('The supervisor control directory is unsafe.');
  }
  if ((direct.mode & 0o777) !== 0o700) {
    throw new SupervisorJournalError('The supervisor control directory is not private.');
  }
  if (typeof process.getuid === 'function' && direct.uid !== process.getuid()) {
    throw new SupervisorJournalError('The supervisor control directory has the wrong owner.');
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function repairStalePublishLink(path: string, published: ReturnType<typeof fstatSync>): boolean {
  const directory = dirname(path);
  const prefix = `.${basename(path)}.`;
  const candidates = readdirSync(directory, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.tmp'),
  );
  const matching = candidates.filter((entry) => {
    try {
      const info = lstatSync(join(directory, entry.name));
      return (
        !info.isSymbolicLink() &&
        info.dev === published.dev &&
        info.ino === published.ino &&
        info.nlink === 2 &&
        (info.mode & 0o777) === 0o600 &&
        (typeof process.getuid !== 'function' || info.uid === process.getuid())
      );
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  });
  if (matching.length !== 1) return false;
  const stage = join(directory, matching[0]?.name ?? '');
  const stageInfo = lstatSync(stage);
  // Do not interfere with the normal micro-window between link and unlink.
  // A one-second-old sibling is durable crash residue, not an active publish.
  if (Date.now() - stageInfo.mtimeMs < 1_000) return false;
  unlinkSync(stage);
  fsyncDirectory(directory);
  return true;
}

function readJournal<T>(path: string, parse: (value: unknown) => T): T | undefined {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      if (errorCode(error) === 'ELOOP') {
        throw new SupervisorJournalError('A supervisor journal path is a symbolic link.');
      }
      throw error;
    }
    try {
      const before = fstatSync(descriptor);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' && before.uid !== process.getuid())
      ) {
        // The atomic publisher briefly has two links. Retry that narrow window
        // rather than treating a complete in-flight publish as corruption. If
        // the publisher crashed after link(), repair its old staging sibling.
        if (before.isFile() && before.nlink === 2) {
          if (repairStalePublishLink(path, before) || attempt < 3) continue;
        }
        throw new SupervisorJournalError('A supervisor journal is not one private file.');
      }
      if (before.size === 0 || before.size > MAX_SUPERVISOR_MESSAGE_BYTES) {
        throw new SupervisorJournalError('A supervisor journal has an invalid size.');
      }
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      const atPath = lstatSync(path);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        after.dev !== atPath.dev ||
        after.ino !== atPath.ino ||
        atPath.isSymbolicLink()
      ) {
        if (attempt < 3) continue;
        throw new SupervisorJournalError('A supervisor journal changed while Circuit read it.');
      }
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new SupervisorJournalError('A supervisor journal does not contain valid JSON.');
      }
      try {
        return parse(value);
      } catch {
        throw new SupervisorJournalError('A supervisor journal contains an invalid record.');
      }
    } finally {
      closeSync(descriptor);
    }
  }
  throw new SupervisorJournalError('A supervisor journal remained busy.');
}

function sameRuntime(left: RuntimeJournal['runtime'], right: ExitJournal['runtime']): boolean {
  return (
    left.pid === right.pid &&
    left.process_group_id === right.process_group_id &&
    left.birth_token === right.birth_token &&
    left.started_at === right.started_at
  );
}

export interface ReadSupervisorJournalsInput {
  readonly control_directory: string;
  readonly run_id: string;
  readonly generation: number;
  readonly authorization_sha256: string;
}

export interface SupervisorJournalObservations {
  readonly runtime?: RuntimeJournal;
  readonly exit?: ExitJournal;
}

export function readSupervisorJournals(
  input: ReadSupervisorJournalsInput,
): SupervisorJournalObservations {
  assertPrivateCanonicalDirectory(input.control_directory);
  const runtimeName = `launch-${input.generation}-runtime.json`;
  const exitName = `launch-${input.generation}-exit.json`;
  if (basename(runtimeName) !== runtimeName || basename(exitName) !== exitName) {
    throw new SupervisorJournalError('The supervisor journal name is invalid.');
  }
  const runtime = readJournal(join(input.control_directory, runtimeName), (value) =>
    RuntimeJournalV1.parse(value),
  );
  const exit = readJournal(join(input.control_directory, exitName), (value) =>
    ExitJournalV1.parse(value),
  );
  for (const observed of [runtime, exit]) {
    if (observed === undefined) continue;
    if (
      observed.run_id !== input.run_id ||
      observed.generation !== input.generation ||
      observed.authorization_sha256 !== input.authorization_sha256
    ) {
      throw new SupervisorJournalError('A supervisor journal belongs to another launch.');
    }
    if (observed.runtime.birth_token !== input.authorization_sha256) {
      throw new SupervisorJournalError(
        'A supervisor journal worker identity has the wrong launch token.',
      );
    }
  }
  if (exit !== undefined && runtime === undefined) {
    throw new SupervisorJournalError('Supervisor exit evidence is missing its runtime record.');
  }
  if (runtime !== undefined && exit !== undefined && !sameRuntime(runtime.runtime, exit.runtime)) {
    throw new SupervisorJournalError('Supervisor runtime and exit evidence do not match.');
  }
  return {
    ...(runtime === undefined ? {} : { runtime }),
    ...(exit === undefined ? {} : { exit }),
  };
}
