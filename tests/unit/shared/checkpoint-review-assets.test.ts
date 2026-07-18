import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { CheckpointReviewAssetGroup } from '../../../src/schemas/checkpoint-review-assets.js';
import { snapshotCheckpointReviewAssetGroups } from '../../../src/shared/checkpoint-review-assets.js';

const roots: string[] = [];

function snapshotCheckpointReviewAssetGroup(input: {
  readonly projectRoot: string;
  readonly root: string;
  readonly entryPoints: readonly string[];
}): CheckpointReviewAssetGroup | undefined {
  return snapshotCheckpointReviewAssetGroups({
    projectRoot: input.projectRoot,
    groups: [{ root: input.root, entryPoints: input.entryPoints }],
  })[0];
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'circuit-review-asset-snapshot-'));
  roots.push(root);
  return root;
}

function write(root: string, path: string, bytes: string | Uint8Array): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes);
}

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('snapshotCheckpointReviewAssetGroup', () => {
  it('binds every supported file under the root in deterministic order and excludes scripts', () => {
    const projectRoot = fixture();
    write(projectRoot, 'prototype/index.html', '<main>Card</main>');
    write(projectRoot, 'prototype/styles/card.css', 'main{color:red}');
    write(projectRoot, 'prototype/images/card.png', Uint8Array.from([1, 2, 3]));
    write(projectRoot, 'prototype/images/icon.svg', '<svg></svg>');
    write(projectRoot, 'prototype/fonts/card.woff2', Uint8Array.from([4, 5, 6]));
    write(projectRoot, 'prototype/app.js', 'fetch("https://attacker.example")');
    write(projectRoot, 'prototype/README.md', 'not part of the browser preview');

    const snapshot = snapshotCheckpointReviewAssetGroup({
      projectRoot,
      root: 'prototype',
      entryPoints: ['prototype/index.html'],
    });

    expect(snapshot).toEqual({
      root: 'prototype',
      entry_points: ['prototype/index.html'],
      files: [
        { path: 'prototype/fonts/card.woff2', sha256: sha256(Uint8Array.from([4, 5, 6])) },
        { path: 'prototype/images/card.png', sha256: sha256(Uint8Array.from([1, 2, 3])) },
        { path: 'prototype/images/icon.svg', sha256: sha256('<svg></svg>') },
        { path: 'prototype/index.html', sha256: sha256('<main>Card</main>') },
        { path: 'prototype/styles/card.css', sha256: sha256('main{color:red}') },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('app.js');
    expect(JSON.stringify(snapshot)).not.toContain('README.md');
  });

  it('returns no group when none of the declared entry points use a preview format', () => {
    const projectRoot = fixture();
    write(projectRoot, 'prototype/cli.js', 'console.log("hello")');

    expect(
      snapshotCheckpointReviewAssetGroup({
        projectRoot,
        root: 'prototype',
        entryPoints: ['prototype/cli.js'],
      }),
    ).toBeUndefined();
  });

  it('rejects a symlink anywhere in the recursively scanned root', () => {
    const projectRoot = fixture();
    const outside = join(projectRoot, 'outside.png');
    writeFileSync(outside, 'private');
    write(projectRoot, 'prototype/index.html', '<main>Card</main>');
    symlinkSync(outside, join(projectRoot, 'prototype', 'escape.png'));

    expect(() =>
      snapshotCheckpointReviewAssetGroup({
        projectRoot,
        root: 'prototype',
        entryPoints: ['prototype/index.html'],
      }),
    ).toThrow(/symlink/);
  });

  it('refuses to create a partial identity when the supported-file count exceeds the bound', () => {
    const projectRoot = fixture();
    write(projectRoot, 'prototype/index.html', '<main>Card</main>');
    for (let index = 0; index < 32; index += 1) {
      write(projectRoot, `prototype/images/${String(index).padStart(2, '0')}.png`, 'x');
    }

    expect(() =>
      snapshotCheckpointReviewAssetGroup({
        projectRoot,
        root: 'prototype',
        entryPoints: ['prototype/index.html'],
      }),
    ).toThrow(/more than 32 supported files/);
  });
});
