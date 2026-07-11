import { describe, expect, it } from 'vitest';

import { collapseIdenticalCodeWarnings } from '../../src/cli/run-stdout-envelope.js';

describe('collapseIdenticalCodeWarnings', () => {
  it('collapses repeated identical-code warnings into one line with a count and the largest example', () => {
    const collapsed = collapseIdenticalCodeWarnings([
      { code: 'source_pruned', message: 'pruned 500 noisy characters from reports/a.json' },
      { code: 'source_pruned', message: 'pruned 12000 noisy characters from reports/b.json' },
      { code: 'source_pruned', message: 'pruned 900 noisy characters from reports/c.json' },
    ]);

    expect(collapsed).toEqual([
      {
        code: 'source_pruned',
        message: 'source_pruned x3 (largest: pruned 12000 noisy characters from reports/b.json)',
      },
    ]);
  });

  it('leaves a single warning per code untouched', () => {
    const collapsed = collapseIdenticalCodeWarnings([
      { code: 'source_pruned', message: 'pruned 500 noisy characters from reports/a.json' },
      { code: 'source_invalid', message: 'history index may be stale' },
    ]);

    expect(collapsed).toEqual([
      { code: 'source_pruned', message: 'pruned 500 noisy characters from reports/a.json' },
      { code: 'source_invalid', message: 'history index may be stale' },
    ]);
  });

  it('returns an empty list for no warnings', () => {
    expect(collapseIdenticalCodeWarnings([])).toEqual([]);
  });
});
