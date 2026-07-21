import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fileOpenHooks = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((file: string) => Promise<void>),
  wrapHandle: undefined as
    | undefined
    | ((
        file: string,
        handle: import('node:fs/promises').FileHandle,
      ) => import('node:fs/promises').FileHandle),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = String(args[0]);
      await fileOpenHooks.beforeOpen?.(file);
      const handle = await actual.open(...args);
      return fileOpenHooks.wrapHandle?.(file, handle) ?? handle;
    },
  };
});

import { checkpointViewForJob } from './checkpoint-view.mjs';

const roots: string[] = [];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture() {
  const runFolder = await realpath(
    await mkdtemp(path.join(tmpdir(), 'circuit-mcp-checkpoint-view-')),
  );
  roots.push(runFolder);
  const reviewPath = 'reports/build/brief.json';
  const requestPath = 'reports/checkpoints/frame-step-request.json';
  const reviewBody = `${JSON.stringify({ schema: 'build.brief@v1', scope: 'Bounded change.' })}\n`;
  await mkdir(path.join(runFolder, 'reports/build'), { recursive: true });
  await mkdir(path.join(runFolder, 'reports/checkpoints'), { recursive: true });
  await writeFile(path.join(runFolder, reviewPath), reviewBody);
  const request = {
    schema_version: 1,
    step_id: 'frame-step',
    prompt: 'Confirm the Build brief.',
    allowed_choices: ['continue'],
    choices: [{ id: 'continue', label: 'Continue', description: 'Start implementation.' }],
    safe_default_choice: 'continue',
    execution_context: {
      review_inputs: [{ path: reviewPath, sha256: sha256(reviewBody) }],
    },
  };
  const requestBody = `${JSON.stringify(request)}\n`;
  const requestAbsolute = path.join(runFolder, requestPath);
  await writeFile(requestAbsolute, requestBody);
  const job = {
    runFolder,
    final: {
      checkpoint: {
        step_id: 'frame-step',
        request_path: requestAbsolute,
        request_sha256: sha256(requestBody),
        allowed_choices: ['continue'],
      },
    },
  };
  return { job, requestAbsolute, reviewPath, reviewBody, runFolder };
}

afterEach(async () => {
  fileOpenHooks.beforeOpen = undefined;
  fileOpenHooks.wrapHandle = undefined;
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe('MCP checkpoint decision view', () => {
  it('returns only the hash-bound prompt, labeled choices, and review material', async () => {
    const { job } = await fixture();
    await expect(checkpointViewForJob(job)).resolves.toMatchObject({
      step_id: 'frame-step',
      prompt: 'Confirm the Build brief.',
      choices: [{ id: 'continue', label: 'Continue', description: 'Start implementation.' }],
      review_material: [
        {
          path: 'reports/build/brief.json',
          content: { schema: 'build.brief@v1', scope: 'Bounded change.' },
        },
      ],
    });
  });

  it('rejects a checkpoint request changed after Circuit paused', async () => {
    const { job, requestAbsolute } = await fixture();
    await writeFile(requestAbsolute, '{"changed":true}\n');
    await expect(checkpointViewForJob(job)).rejects.toThrow(
      'Checkpoint request changed after Circuit paused',
    );
  });

  it('rejects a symbolic-link review input', async () => {
    const { job, reviewPath, reviewBody, runFolder } = await fixture();
    const outside = path.join(runFolder, 'outside.json');
    await writeFile(outside, reviewBody);
    await rm(path.join(runFolder, reviewPath));
    await symlink(outside, path.join(runFolder, reviewPath));
    await expect(checkpointViewForJob(job)).rejects.toThrow('must not cross a symbolic link');
  });

  it('rejects an intermediate directory swapped to a symbolic link before open', async () => {
    const { job, reviewPath, reviewBody, runFolder } = await fixture();
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'circuit-mcp-outside-')));
    roots.push(outside);
    await writeFile(path.join(outside, 'brief.json'), reviewBody);

    const reviewAbsolute = path.join(runFolder, reviewPath);
    const reviewDirectory = path.dirname(reviewAbsolute);
    const savedDirectory = `${reviewDirectory}-saved`;
    fileOpenHooks.beforeOpen = async (file) => {
      if (path.resolve(file) !== reviewAbsolute) return;
      fileOpenHooks.beforeOpen = undefined;
      await rename(reviewDirectory, savedDirectory);
      await symlink(outside, reviewDirectory);
    };

    await expect(checkpointViewForJob(job)).rejects.toThrow('must not cross a symbolic link');
  });

  it('stops reading when a checkpoint file grows beyond its byte limit', async () => {
    const { job, requestAbsolute } = await fixture();
    let grew = false;
    fileOpenHooks.wrapHandle = (file, handle) => {
      if (path.resolve(file) !== requestAbsolute) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'stat') {
            return async (...args: Parameters<typeof target.stat>) => {
              const stat = await target.stat(...args);
              if (!grew) {
                grew = true;
                await appendFile(requestAbsolute, Buffer.alloc(256 * 1024, 0x20));
              }
              return stat;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

    await expect(checkpointViewForJob(job)).rejects.toThrow('Checkpoint request is too large');
  });
});
