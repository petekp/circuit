import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonAtomic, writeTextAtomic } from '../../../src/shared/atomic-io.js';

describe('atomic-io', () => {
  let dir: string;

  function tempDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'circuit-atomic-io-'));
    return dir;
  }

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes text atomically and leaves no staging file behind', () => {
    const target = join(tempDir(), 'out.txt');
    writeTextAtomic(target, 'hello\n');
    expect(readFileSync(target, 'utf8')).toBe('hello\n');
    expect(readdirSync(dir)).toEqual(['out.txt']);
  });

  it('writes json with 2-space indent and trailing newline', () => {
    const target = join(tempDir(), 'out.json');
    writeJsonAtomic(target, { a: 1 });
    expect(readFileSync(target, 'utf8')).toBe('{\n  "a": 1\n}\n');
  });

  it('a validate failure leaves the target untouched and removes the staged temp file', () => {
    const target = join(tempDir(), 'out.json');
    writeFileSync(target, 'original\n');
    expect(() =>
      writeTextAtomic(target, 'replacement\n', {
        validate: () => {
          throw new Error('validation rejected the staged bytes');
        },
      }),
    ).toThrow('validation rejected the staged bytes');
    expect(readFileSync(target, 'utf8')).toBe('original\n');
    expect(readdirSync(dir)).toEqual(['out.json']);
  });

  it('validate sees the staged bytes, not the old target bytes', () => {
    const target = join(tempDir(), 'out.txt');
    writeFileSync(target, 'old\n');
    let seen: string | undefined;
    writeTextAtomic(target, 'new\n', {
      validate: (raw) => {
        seen = raw;
      },
    });
    expect(seen).toBe('new\n');
    expect(readFileSync(target, 'utf8')).toBe('new\n');
  });
});
