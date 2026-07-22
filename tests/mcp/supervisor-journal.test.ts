import { existsSync } from 'node:fs';
import { link, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readSupervisorJournals } from '../../src/hosts/codex-mcp/supervisor-journal.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const AUTHORIZATION = 'a'.repeat(64);
const NOW = '2026-07-21T08:00:00.000Z';
const roots: string[] = [];

async function root(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'circuit-mcp-journal-')));
  roots.push(path);
  return path;
}

function runtime() {
  return {
    schema_version: 1,
    record_kind: 'circuit.mcp.runtime-observation',
    run_id: RUN_ID,
    generation: 1,
    authorization_sha256: AUTHORIZATION,
    runtime: {
      pid: 100,
      process_group_id: 100,
      birth_token: AUTHORIZATION,
      started_at: NOW,
    },
    runtime_executable: {
      real_path: '/usr/local/bin/node',
      device: '1',
      inode: '2',
      sha256: 'b'.repeat(64),
    },
    recorded_at: NOW,
  };
}

function exit() {
  return {
    schema_version: 1,
    record_kind: 'circuit.mcp.exit-observation',
    run_id: RUN_ID,
    generation: 1,
    authorization_sha256: AUTHORIZATION,
    runtime: runtime().runtime,
    observed_at: NOW,
    exit_code: 0,
    process_group_cleanup: 'confirmed',
  };
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('supervisor journal reader', () => {
  it('returns matching, complete runtime and exit evidence', async () => {
    const directory = await root();
    await writePrivate(join(directory, 'launch-1-runtime.json'), runtime());
    await writePrivate(join(directory, 'launch-1-exit.json'), exit());
    expect(
      readSupervisorJournals({
        control_directory: directory,
        run_id: RUN_ID,
        generation: 1,
        authorization_sha256: AUTHORIZATION,
      }),
    ).toMatchObject({
      runtime: { runtime: { pid: 100 } },
      exit: { exit_code: 0, process_group_cleanup: 'confirmed' },
    });
  });

  it('rejects an exit record without its runtime record', async () => {
    const directory = await root();
    await writePrivate(join(directory, 'launch-1-exit.json'), exit());
    expect(() =>
      readSupervisorJournals({
        control_directory: directory,
        run_id: RUN_ID,
        generation: 1,
        authorization_sha256: AUTHORIZATION,
      }),
    ).toThrow(/missing its runtime/i);
  });

  it('repairs a stale staging hard link left after a completed publish', async () => {
    const directory = await root();
    const published = join(directory, 'launch-1-runtime.json');
    const stage = join(
      directory,
      '.launch-1-runtime.json.11111111-1111-4111-8111-111111111111.tmp',
    );
    await writePrivate(published, runtime());
    await link(published, stage);
    await utimes(stage, new Date(0), new Date(0));

    expect(
      readSupervisorJournals({
        control_directory: directory,
        run_id: RUN_ID,
        generation: 1,
        authorization_sha256: AUTHORIZATION,
      }),
    ).toMatchObject({ runtime: { runtime: { pid: 100 } } });
    expect(existsSync(stage)).toBe(false);
    expect(existsSync(published)).toBe(true);
  });

  it('rejects records bound to another authorization or runtime', async () => {
    const directory = await root();
    await writePrivate(join(directory, 'launch-1-runtime.json'), runtime());
    await writePrivate(join(directory, 'launch-1-exit.json'), {
      ...exit(),
      runtime: { ...exit().runtime, birth_token: 'replacement-process' },
    });
    expect(() =>
      readSupervisorJournals({
        control_directory: directory,
        run_id: RUN_ID,
        generation: 1,
        authorization_sha256: AUTHORIZATION,
      }),
    ).toThrow(/wrong launch token/i);

    expect(() =>
      readSupervisorJournals({
        control_directory: directory,
        run_id: RUN_ID,
        generation: 1,
        authorization_sha256: 'b'.repeat(64),
      }),
    ).toThrow(/another launch/i);
  });

  it('rejects matching journals whose worker token differs from the committed launch token', async () => {
    const directory = await root();
    const wrongRuntime = {
      ...runtime(),
      runtime: { ...runtime().runtime, birth_token: 'wrong-worker-token' },
    };
    await writePrivate(join(directory, 'launch-1-runtime.json'), wrongRuntime);
    await writePrivate(join(directory, 'launch-1-exit.json'), {
      ...exit(),
      runtime: wrongRuntime.runtime,
    });

    expect(() =>
      readSupervisorJournals({
        control_directory: directory,
        run_id: RUN_ID,
        generation: 1,
        authorization_sha256: AUTHORIZATION,
      }),
    ).toThrow(/worker.*token|launch token/i);
  });

  it('rejects linked, empty, and non-private journal files', async () => {
    const directory = await root();
    const outside = join(directory, 'outside.json');
    await writePrivate(outside, runtime());
    await symlink(outside, join(directory, 'launch-1-runtime.json'));
    expect(() =>
      readSupervisorJournals({
        control_directory: directory,
        run_id: RUN_ID,
        generation: 1,
        authorization_sha256: AUTHORIZATION,
      }),
    ).toThrow(/symbolic link/i);

    await rm(join(directory, 'launch-1-runtime.json'));
    await writeFile(join(directory, 'launch-1-runtime.json'), '', { mode: 0o600 });
    expect(() =>
      readSupervisorJournals({
        control_directory: directory,
        run_id: RUN_ID,
        generation: 1,
        authorization_sha256: AUTHORIZATION,
      }),
    ).toThrow(/invalid size/i);

    await rm(join(directory, 'launch-1-runtime.json'));
    await writeFile(join(directory, 'launch-1-runtime.json'), `${JSON.stringify(runtime())}\n`, {
      mode: 0o644,
    });
    expect(() =>
      readSupervisorJournals({
        control_directory: directory,
        run_id: RUN_ID,
        generation: 1,
        authorization_sha256: AUTHORIZATION,
      }),
    ).toThrow(/not one private file/i);
  });
});
