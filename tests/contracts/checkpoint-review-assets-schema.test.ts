import { describe, expect, it } from 'vitest';

import {
  CheckpointReviewAssetGroup,
  CheckpointReviewAssetGroups,
} from '../../src/schemas/checkpoint-review-assets.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function group() {
  return {
    root: '.circuit/prototypes/run-1',
    entry_points: ['.circuit/prototypes/run-1/index.html'],
    files: [
      { path: '.circuit/prototypes/run-1/index.html', sha256: SHA_A },
      { path: '.circuit/prototypes/run-1/styles.css', sha256: SHA_B },
    ],
  };
}

describe('CheckpointReviewAssetGroup', () => {
  it('accepts a closed project-relative asset group', () => {
    expect(CheckpointReviewAssetGroup.parse(group())).toEqual(group());
    expect(CheckpointReviewAssetGroups.parse([group()])).toEqual([group()]);
  });

  it.each([
    ['/absolute/root', 'path must be project-relative'],
    ['C:drive-relative', 'path must be project-relative'],
    ['../escape', 'must not escape'],
    ['safe/../escape', 'must not escape'],
    ['safe\\windows', 'forward slashes'],
    ['safe//empty', 'normalized'],
    ['safe/trailing/', 'must not end'],
  ])('rejects unsafe or non-normalized root %s', (root, message) => {
    expect(() => CheckpointReviewAssetGroup.parse({ ...group(), root })).toThrow(message);
  });

  it('requires every entry point and file to stay under the root', () => {
    expect(() =>
      CheckpointReviewAssetGroup.parse({
        ...group(),
        entry_points: ['elsewhere/index.html'],
      }),
    ).toThrow(/inside review asset root/);
    expect(() =>
      CheckpointReviewAssetGroup.parse({
        ...group(),
        files: [{ path: 'elsewhere/index.html', sha256: SHA_A }],
      }),
    ).toThrow(/inside review asset root/);
  });

  it('requires each entry point to name one of the bound files', () => {
    expect(() =>
      CheckpointReviewAssetGroup.parse({
        ...group(),
        entry_points: ['.circuit/prototypes/run-1/missing.html'],
      }),
    ).toThrow(/must name a bound file/);
  });

  it('rejects duplicate roots, file paths, invalid hashes, and surplus keys', () => {
    expect(() => CheckpointReviewAssetGroups.parse([group(), group()])).toThrow(/duplicate root/);
    expect(() =>
      CheckpointReviewAssetGroup.parse({
        ...group(),
        files: [group().files[0], group().files[0]],
      }),
    ).toThrow(/duplicate file path/);
    expect(() =>
      CheckpointReviewAssetGroup.parse({
        ...group(),
        files: [{ path: '.circuit/prototypes/run-1/index.html', sha256: 'NOT-A-HASH' }],
      }),
    ).toThrow(/SHA-256/);
    expect(() => CheckpointReviewAssetGroup.parse({ ...group(), extra: true })).toThrow();
  });
});
