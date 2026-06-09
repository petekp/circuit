// Drift guard: Build's git-state helper must stay byte-identical to Fix's.
//
// The touch-area gate runs the same working-tree snapshot helper Fix uses, but
// the engine<->flow boundary forbids Build from importing Fix's copy, so Build
// keeps its own sibling at src/flows/build/writers/git-state.ts. This is
// adversary-resistant git-parsing code; two copies that silently diverge would
// be a security liability (a fix to one missing the other). This test fails the
// moment they differ, forcing any change to land in both — until they are
// unified into a shared module (tracked follow-up).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FIX_HELPER = resolve(process.cwd(), 'src/flows/fix/writers/git-state.ts');
const BUILD_HELPER = resolve(process.cwd(), 'src/flows/build/writers/git-state.ts');

describe('build git-state helper drift guard', () => {
  it('Build git-state.ts is byte-identical to Fix git-state.ts', () => {
    const fix = readFileSync(FIX_HELPER, 'utf8');
    const build = readFileSync(BUILD_HELPER, 'utf8');
    expect(
      build,
      'src/flows/build/writers/git-state.ts drifted from the Fix copy. These two ' +
        'adversary-resistant helpers must stay identical; apply the change to both, ' +
        'or unify them into a shared module.',
    ).toEqual(fix);
  });
});
