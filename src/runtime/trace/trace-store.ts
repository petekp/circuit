// Append-only trace.ndjson store.
//
// This is the sequence authority for runtime events. Callers provide event
// bodies; TraceStore assigns contiguous sequence numbers, persists one JSON
// object per line, rejects writes after run.closed, and lets projection hooks
// fail without corrupting the trace.

import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { TraceEntry as TraceEntrySchema } from '../../schemas/trace-entry.js';
import type { TraceEntry, TraceEntryInput } from '../domain/trace.js';

export interface TraceStoreOptions {
  readonly now?: () => Date;
  readonly onAppend?: (entry: TraceEntry) => void | Promise<void>;
}

export class TraceStore {
  private readonly tracePath: string;
  private entries: TraceEntry[] = [];
  private nextSequence = 0;
  private closed = false;
  private appendTail: Promise<void> = Promise.resolve();
  // Byte length of the last consistent (complete-line) prefix when load() drops
  // a torn trailing line. The next append truncates the torn bytes first so it
  // cannot concatenate onto a half-written record. undefined => nothing to heal.
  private healToByteLength: number | undefined;

  constructor(
    readonly runDir: string,
    private readonly options: TraceStoreOptions = {},
  ) {
    this.tracePath = join(runDir, 'trace.ndjson');
  }

  async load(): Promise<readonly TraceEntry[]> {
    await this.appendTail;
    let raw = '';
    try {
      raw = await readFile(this.tracePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries = [];
        this.nextSequence = 0;
        this.closed = false;
        return this.entries;
      }
      throw error;
    }

    // Parse one JSON object per line, tolerating a torn/unparseable FINAL line —
    // the expected artifact of a crash mid-append. Appends are serialized and
    // each writes one complete `${json}\n`, so only the last line can be
    // half-written; treat the trace as ending at the last complete line. The
    // torn record names an action that never durably happened. Any earlier
    // unparseable line is real interior corruption and must fail loud.
    //
    // Scan the UNFILTERED split and accumulate true on-disk byte offsets so the
    // heal length is measured in real bytes: a stray blank line before the torn
    // tail must not shift it (re-joining a blank-filtered line set would drop
    // that blank's newline and truncate into the last complete record).
    const segments = raw.split('\n');
    let lastContentIndex = -1;
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if ((segments[index] ?? '').trim().length > 0) {
        lastContentIndex = index;
        break;
      }
    }
    const rawEntries: unknown[] = [];
    this.healToByteLength = undefined;
    let byteOffset = 0;
    for (const [index, segment] of segments.entries()) {
      // Every segment except the last was followed by a `\n` that split removed.
      const onDiskBytes =
        Buffer.byteLength(segment, 'utf8') + (index < segments.length - 1 ? 1 : 0);
      if (segment.trim().length === 0) {
        // A blank line. The writer never emits one, but a damaged file might;
        // skip it without disturbing the byte accounting.
        byteOffset += onDiskBytes;
        continue;
      }
      try {
        rawEntries.push(JSON.parse(segment) as unknown);
      } catch (error) {
        if (index === lastContentIndex) {
          // Torn FINAL line. Remember the clean-prefix byte length (everything
          // before this physical line) so the next append truncates the torn
          // bytes instead of concatenating onto them. load() itself stays
          // read-only: inspection and result regeneration must never mutate a
          // crashed run's trace.
          this.healToByteLength = byteOffset;
          break;
        }
        throw new Error(
          `trace entry ${index} is not valid JSON (interior corruption): ${(error as Error).message}`,
        );
      }
      byteOffset += onDiskBytes;
    }
    const entries: TraceEntry[] = [];
    for (const [index, entry] of rawEntries.entries()) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`trace entry ${index} is not an object`);
      }
      const candidate = TraceEntrySchema.parse(entry) as unknown as TraceEntry;
      if (typeof candidate.sequence !== 'number' || !Number.isInteger(candidate.sequence)) {
        throw new Error(`trace entry ${index} has no integer sequence`);
      }
      if (candidate.sequence !== index) {
        throw new Error(
          `trace sequence mismatch at entry ${index}: expected ${index}, found ${candidate.sequence}`,
        );
      }
      entries.push(candidate);
    }
    const closedIndex = entries.findIndex((entry) => entry.kind === 'run.closed');
    if (closedIndex !== -1 && closedIndex !== entries.length - 1) {
      throw new Error(`trace entry after run.closed at sequence ${closedIndex}`);
    }
    this.entries = entries;
    this.nextSequence =
      entries.length === 0 ? 0 : Math.max(...entries.map((entry) => entry.sequence)) + 1;
    this.closed = entries.some((entry) => entry.kind === 'run.closed');
    return this.entries;
  }

  async append(input: TraceEntryInput): Promise<TraceEntry> {
    const appendOne = async (): Promise<TraceEntry> => {
      if (this.closed) {
        throw new Error('cannot append trace entry after run close');
      }

      const entry = TraceEntrySchema.parse({
        ...input,
        schema_version: input.schema_version ?? 1,
        recorded_at: input.recorded_at ?? (this.options.now ?? (() => new Date()))().toISOString(),
        sequence: this.nextSequence,
      }) as unknown as TraceEntry;
      await mkdir(this.runDir, { recursive: true });
      if (this.healToByteLength !== undefined) {
        // A prior load() dropped a torn trailing line. Truncate the torn bytes
        // before appending so the new record starts on a clean line boundary.
        // The torn event is unrecoverable by construction: it was cut mid-write
        // by a crash, so it never durably happened from the trace's point of
        // view. Accepted tradeoff — the alternative is refusing to resume.
        await truncate(this.tracePath, this.healToByteLength);
        this.healToByteLength = undefined;
      }
      await appendFile(this.tracePath, `${JSON.stringify(entry)}\n`, 'utf8');

      this.nextSequence += 1;
      this.entries.push(entry);

      if (entry.kind === 'run.closed') {
        this.closed = true;
      }

      try {
        await this.options.onAppend?.(entry);
      } catch {
        // Progress/projection side channels must not corrupt trace persistence.
      }

      return entry;
    };

    const result = this.appendTail.then(appendOne, appendOne);
    this.appendTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  getAll(): readonly TraceEntry[] {
    return this.entries;
  }
}
