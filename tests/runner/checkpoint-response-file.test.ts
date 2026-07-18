import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CheckpointResponseFileError,
  MAX_CHECKPOINT_RESPONSE_FILE_BYTES,
  readCheckpointResponseFile,
  resolveCheckpointResponseFilePath,
} from '../../src/cli/checkpoint-response-file.js';

const RUN_ID = '92000000-0000-4000-8000-000000000001';

function response(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schema: 'checkpoint.review-response@v1',
    run_id: RUN_ID,
    step_id: 'checkpoint-step',
    attempt: 1,
    request_sha256: 'a'.repeat(64),
    selection: 'continue',
    comments: [],
    ...overrides,
  };
}

function thrownBy(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected operation to throw');
}

describe('checkpoint response file reader', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'circuit-checkpoint-response-file-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves relative paths from the current working directory only', () => {
    const cwd = join(root, 'current project');
    const runFolder = join(root, 'run-folder');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(runFolder, { recursive: true });
    writeFileSync(join(cwd, 'review.json'), '{}');
    writeFileSync(join(runFolder, 'review.json'), '{"wrong":true}');

    expect(resolveCheckpointResponseFilePath('review.json', cwd)).toBe(join(cwd, 'review.json'));
  });

  it('preserves absolute paths and reads a pretty-printed browser response', () => {
    const path = join(root, "Pete's exported review.json");
    writeFileSync(path, `${JSON.stringify(response(), null, 2)}\n`);

    expect(resolveCheckpointResponseFilePath(path, join(root, 'elsewhere'))).toBe(path);
    expect(readCheckpointResponseFile({ argument: path, cwd: join(root, 'elsewhere') })).toEqual(
      response(),
    );
  });

  it('rejects raw files above the transport limit before JSON parsing', () => {
    const path = join(root, 'oversized.json');
    writeFileSync(
      path,
      `${JSON.stringify(response())}${' '.repeat(MAX_CHECKPOINT_RESPONSE_FILE_BYTES)}`,
    );

    const error = thrownBy(() => readCheckpointResponseFile({ argument: path, cwd: root }));
    expect(error).toBeInstanceOf(CheckpointResponseFileError);
    expect(error).toMatchObject({ code: 'too_large', path });
    expect(error.message).toContain('64 KiB');
  });

  it('rejects folders and devices instead of treating them as response bytes', () => {
    const directory = join(root, 'not-a-file');
    mkdirSync(directory);

    const directoryError = thrownBy(() =>
      readCheckpointResponseFile({ argument: directory, cwd: root }),
    );
    expect(directoryError).toMatchObject({ code: 'not_regular_file', path: directory });

    if (process.platform !== 'win32') {
      const deviceError = thrownBy(() =>
        readCheckpointResponseFile({ argument: '/dev/null', cwd: root }),
      );
      expect(deviceError).toMatchObject({ code: 'not_regular_file', path: '/dev/null' });
    }
  });

  it('rejects invalid UTF-8 without replacing or corrupting review text', () => {
    const path = join(root, 'invalid-utf8.json');
    writeFileSync(path, Buffer.from([0x7b, 0x22, 0x62, 0x6f, 0x64, 0x79, 0x22, 0x3a, 0x22, 0xff]));

    const error = thrownBy(() => readCheckpointResponseFile({ argument: path, cwd: root }));
    expect(error).toMatchObject({ code: 'invalid_utf8', path });
    expect(error.message).toContain('valid UTF-8');
  });

  it('does not echo malformed JSON or schema contents in errors', () => {
    const jsonPath = join(root, 'malformed.json');
    writeFileSync(jsonPath, '{"body":private review note}');

    const jsonError = thrownBy(() => readCheckpointResponseFile({ argument: jsonPath, cwd: root }));
    expect(jsonError).toMatchObject({ code: 'invalid_json', path: jsonPath });
    expect(jsonError.message).not.toContain('private review note');
    expect(jsonError.message).not.toContain('{"body"');

    const positionedPath = join(root, 'positioned-error.json');
    writeFileSync(positionedPath, '{"body":"private review note" trailing}');
    const positionedError = thrownBy(() =>
      readCheckpointResponseFile({ argument: positionedPath, cwd: root }),
    );
    expect(positionedError.message).toMatch(/line 1, column \d+/);
    expect(positionedError.message).not.toContain('private review note');

    const schemaPath = join(root, 'wrong-schema.json');
    writeFileSync(
      schemaPath,
      JSON.stringify({
        ...response({ attempt: 0 }),
        private_review_note: 'secret launch feedback',
      }),
    );

    const schemaError = thrownBy(() =>
      readCheckpointResponseFile({ argument: schemaPath, cwd: root }),
    );
    expect(schemaError).toMatchObject({ code: 'invalid_response', path: schemaPath });
    expect(schemaError.message).toContain('attempt');
    expect(schemaError.message).not.toContain('private_review_note');
    expect(schemaError.message).not.toContain('secret launch feedback');
    expect(schemaError.message).not.toContain('Unrecognized key');
  });
});
