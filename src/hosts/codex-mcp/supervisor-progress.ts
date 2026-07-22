import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

import { ProgressEvent } from '../../schemas/progress-event.js';

const MAX_PROGRESS_FILE_BYTES = 16 * 1_048_576;
const MAX_PROGRESS_LINE_BYTES = 65_536;

const SupervisorProgressRecordV1 = z
  .object({
    schema_version: z.literal(1),
    record_kind: z.literal('circuit.mcp.progress'),
    run_id: z.guid(),
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    event: ProgressEvent,
  })
  .strict();
export type SupervisorProgressRecord = z.infer<typeof SupervisorProgressRecordV1>;

export class SupervisorProgressError extends Error {
  readonly code = 'supervisor_progress_corrupt' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SupervisorProgressError';
  }
}

function progressPath(controlDirectory: string, generation: number): string {
  const name = `launch-${generation}-progress.jsonl`;
  if (basename(name) !== name) throw new Error('invalid supervisor progress name');
  return join(controlDirectory, name);
}

function assertPrivateDirectory(path: string): void {
  const info = lstatSync(path);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (info.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
    realpathSync.native(path) !== path
  ) {
    throw new SupervisorProgressError('The supervisor progress directory is unsafe.');
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

export class SupervisorProgressWriter {
  readonly #descriptor: number;
  readonly #runId: string;
  readonly #generation: number;
  #sequence = 0;
  #bytesWritten = 0;
  #buffer = Buffer.alloc(0);
  #closed = false;

  constructor(input: {
    readonly control_directory: string;
    readonly run_id: string;
    readonly generation: number;
  }) {
    assertPrivateDirectory(input.control_directory);
    this.#runId = input.run_id;
    this.#generation = input.generation;
    const path = progressPath(input.control_directory, input.generation);
    this.#descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const info = fstatSync(this.#descriptor);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) {
      closeSync(this.#descriptor);
      throw new SupervisorProgressError('The supervisor progress file is unsafe.');
    }
    fsyncDirectory(dirname(path));
  }

  ingest(chunk: Buffer | string): void {
    if (this.#closed) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this.#buffer = Buffer.concat([this.#buffer, bytes]);
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      this.#appendLine(line);
    }
    // Ordinary CLI errors may share stderr with progress. They are never
    // copied into durable state. Bound an unterminated diagnostic line too.
    if (this.#buffer.byteLength > MAX_PROGRESS_LINE_BYTES) this.#buffer = Buffer.alloc(0);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
    try {
      fsyncSync(this.#descriptor);
    } finally {
      closeSync(this.#descriptor);
    }
  }

  #appendLine(line: Buffer): void {
    if (line.byteLength === 0 || line.byteLength > MAX_PROGRESS_LINE_BYTES) return;
    let value: unknown;
    try {
      value = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    const event = ProgressEvent.safeParse(value);
    if (!event.success || event.data.run_id !== this.#runId) return;
    const record = SupervisorProgressRecordV1.parse({
      schema_version: 1,
      record_kind: 'circuit.mcp.progress',
      run_id: this.#runId,
      generation: this.#generation,
      sequence: this.#sequence,
      event: event.data,
    });
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    if (this.#bytesWritten + encoded.byteLength > MAX_PROGRESS_FILE_BYTES) return;
    writeSync(this.#descriptor, encoded);
    fsyncSync(this.#descriptor);
    this.#bytesWritten += encoded.byteLength;
    this.#sequence += 1;
  }
}

function readBoundedPrefix(path: string): Buffer | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === 'function' && before.uid !== process.getuid()) ||
      before.size > MAX_PROGRESS_FILE_BYTES
    ) {
      throw new SupervisorProgressError('A supervisor progress file is unsafe or too large.');
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== bytes.byteLength) {
      throw new SupervisorProgressError(
        'A supervisor progress file changed while Circuit read it.',
      );
    }
    const after = fstatSync(descriptor);
    const atPath = lstatSync(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.size < before.size ||
      after.dev !== atPath.dev ||
      after.ino !== atPath.ino ||
      atPath.isSymbolicLink()
    ) {
      throw new SupervisorProgressError(
        'A supervisor progress file changed while Circuit read it.',
      );
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function readSupervisorProgress(input: {
  readonly control_directory: string;
  readonly run_id: string;
  readonly generations: number;
}): SupervisorProgressRecord[] {
  assertPrivateDirectory(input.control_directory);
  const records: SupervisorProgressRecord[] = [];
  for (let generation = 1; generation <= input.generations; generation += 1) {
    const bytes = readBoundedPrefix(progressPath(input.control_directory, generation));
    if (bytes === undefined || bytes.byteLength === 0) continue;
    const completeLength = bytes.lastIndexOf(0x0a);
    if (completeLength < 0) continue;
    const lines = bytes.subarray(0, completeLength).toString('utf8').split('\n');
    for (const [sequence, line] of lines.entries()) {
      let record: SupervisorProgressRecord;
      try {
        record = SupervisorProgressRecordV1.parse(JSON.parse(line));
      } catch {
        throw new SupervisorProgressError('A supervisor progress record is invalid.');
      }
      if (
        record.run_id !== input.run_id ||
        record.generation !== generation ||
        record.sequence !== sequence
      ) {
        throw new SupervisorProgressError('A supervisor progress record has the wrong binding.');
      }
      records.push(record);
    }
  }
  return records;
}
