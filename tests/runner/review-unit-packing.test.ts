import { describe, expect, it } from 'vitest';

import { packReviewUnits } from '../../src/flows/review/index.js';

function file(path: string, size: number): { readonly path: string; readonly size: number } {
  return { path, size };
}

// A unit budget small enough to make the packing decisions visible in a test.
const BUDGET = { maxFilesPerUnit: 4, maxCharsPerUnit: 1000 } as const;

describe('review unit packing', () => {
  it('returns no units for an empty file list', () => {
    expect(packReviewUnits([], BUDGET)).toEqual([]);
  });

  it('puts a whole small codebase in one unit', () => {
    const units = packReviewUnits([file('src/a.ts', 100), file('src/b.ts', 100)], BUDGET);
    expect(units).toHaveLength(1);
    expect(units[0]?.paths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(units[0]?.unit_id).toBe('unit-1');
  });

  // The point of grouping by directory: a unit that has room for the next
  // directory takes it whole rather than taking half of it.
  it('keeps a directory together rather than splitting it across a boundary', () => {
    const units = packReviewUnits(
      [
        file('src/cli/one.ts', 100),
        file('src/cli/two.ts', 100),
        file('src/runtime/a.ts', 300),
        file('src/runtime/b.ts', 300),
        file('src/runtime/c.ts', 300),
      ],
      BUDGET,
    );
    // src/runtime is 900 chars and cannot join the 200-char cli unit without
    // blowing the 1000 budget, so it starts its own unit whole.
    expect(units).toHaveLength(2);
    expect(units[0]?.paths).toEqual(['src/cli/one.ts', 'src/cli/two.ts']);
    expect(units[1]?.paths).toEqual(['src/runtime/a.ts', 'src/runtime/b.ts', 'src/runtime/c.ts']);
  });

  // Cohesion is a preference, not a guarantee. A directory bigger than one
  // unit has to be split, and the split has to be visible in the label.
  it('splits a directory that cannot fit in a single unit and says so', () => {
    const units = packReviewUnits(
      [file('src/big/a.ts', 600), file('src/big/b.ts', 600), file('src/big/c.ts', 600)],
      BUDGET,
    );
    expect(units).toHaveLength(3);
    expect(units.map((unit) => unit.paths)).toEqual([
      ['src/big/a.ts'],
      ['src/big/b.ts'],
      ['src/big/c.ts'],
    ]);
    expect(units[0]?.label).toBe('src/big (part 1)');
    expect(units[2]?.label).toBe('src/big (part 3)');
  });

  it('honors the file-count bound as well as the character bound', () => {
    const units = packReviewUnits(
      [
        file('src/a/1.ts', 1),
        file('src/a/2.ts', 1),
        file('src/a/3.ts', 1),
        file('src/a/4.ts', 1),
        file('src/a/5.ts', 1),
      ],
      BUDGET,
    );
    expect(units).toHaveLength(2);
    expect(units[0]?.paths).toHaveLength(4);
    expect(units[1]?.paths).toEqual(['src/a/5.ts']);
  });

  // A single file over the whole unit budget still has to be reviewed. It gets
  // its own unit; the per-file read bound handles the content.
  it('gives an oversized single file its own unit instead of dropping it', () => {
    const units = packReviewUnits([file('src/small.ts', 50), file('src/huge.ts', 99_999)], BUDGET);
    expect(units.flatMap((unit) => unit.paths)).toContain('src/huge.ts');
    const huge = units.find((unit) => unit.paths.includes('src/huge.ts'));
    expect(huge?.paths).toEqual(['src/huge.ts']);
  });

  it('never loses or duplicates a file', () => {
    const paths = [
      'a.ts',
      'src/cli/x.ts',
      'src/cli/y.ts',
      'src/runtime/deep/nested/z.ts',
      'tests/one.test.ts',
      'tests/two.test.ts',
      'docs/readme.md',
    ];
    const units = packReviewUnits(
      paths.map((path) => file(path, 400)),
      BUDGET,
    );
    const packed = units.flatMap((unit) => unit.paths);
    expect([...packed].sort()).toEqual([...paths].sort());
    expect(new Set(packed).size).toBe(paths.length);
  });

  it('is deterministic: the same input packs the same way regardless of listing order', () => {
    const paths = ['src/b/2.ts', 'src/a/1.ts', 'src/b/1.ts', 'src/a/2.ts'];
    const forward = packReviewUnits(
      paths.map((path) => file(path, 300)),
      BUDGET,
    );
    const reversed = packReviewUnits(
      [...paths].reverse().map((path) => file(path, 300)),
      BUDGET,
    );
    expect(forward).toEqual(reversed);
  });

  it('labels a unit by its directory and numbers units from one', () => {
    const units = packReviewUnits([file('src/cli/one.ts', 100), file('src/runtime/a.ts', 100)], {
      maxFilesPerUnit: 1,
      maxCharsPerUnit: 1000,
    });
    expect(units.map((unit) => unit.unit_id)).toEqual(['unit-1', 'unit-2']);
    expect(units[0]?.label).toBe('src/cli');
    expect(units[1]?.label).toBe('src/runtime');
  });

  it('reports the estimated size it packed against', () => {
    const units = packReviewUnits([file('src/a.ts', 120), file('src/b.ts', 80)], BUDGET);
    expect(units[0]?.estimated_chars).toBe(200);
  });

  it('names the repository root for files that sit at the top level', () => {
    const units = packReviewUnits([file('README.md', 10)], BUDGET);
    expect(units[0]?.label).toBe('the repository root');
  });
});
