// Codex schema temp-file cleanup-on-throw coverage.
//
// `writeSchemaTempFile` allocates an mkdtemp directory and writes a
// JSON-serialized schema into it. If serialization (or the write itself)
// throws AFTER the directory has been created, the directory MUST be
// cleaned up — otherwise every failed relay leaks a `circuit-codex-
// schema-*` directory under the OS temp dir.

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { writeSchemaTempFile } from '../../src/connectors/codex.js';

describe('codex writeSchemaTempFile cleanup', () => {
  it('cleans up the mkdtemp dir when JSON.stringify throws on a BigInt schema', async () => {
    // Redirect the OS temp dir to a private directory for the duration:
    // counting `circuit-codex-schema-*` entries in the shared tmpdir races
    // every other suite worker that allocates or cleans the same pattern.
    // `os.tmpdir()` re-reads TMPDIR on each call, so the SUT allocates here.
    const isolated = await mkdtemp(join(tmpdir(), 'codex-schema-cleanup-probe-'));
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = isolated;
    try {
      // BigInt is not JSON-serializable; JSON.stringify throws synchronously
      // after the temp dir has been allocated. Without cleanup, the dir
      // leaks.
      const badSchema = { weird: 1n } as unknown as Record<string, unknown>;
      await expect(writeSchemaTempFile(badSchema)).rejects.toThrow();
      const leaked = (await readdir(isolated)).filter((entry) =>
        entry.startsWith('circuit-codex-schema-'),
      );
      expect(leaked).toEqual([]);
    } finally {
      if (previousTmpdir === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
      else process.env.TMPDIR = previousTmpdir;
      await rm(isolated, { recursive: true, force: true });
    }
  });

  it('returns dir + path for a well-formed schema and creates a real file', async () => {
    const allocated = await writeSchemaTempFile({ type: 'object' });
    try {
      expect(allocated.dir).toContain('circuit-codex-schema-');
      expect(allocated.path.endsWith('schema.json')).toBe(true);
    } finally {
      // Clean up the dir the test allocated so subsequent test runs start
      // from a clean tmpdir state.
      const { rm } = await import('node:fs/promises');
      await rm(allocated.dir, { recursive: true, force: true });
    }
  });
});
