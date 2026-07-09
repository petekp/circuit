import { describe, expect, it } from 'vitest';

import { normalizeRuntimeBundle } from '../../scripts/plugins/runtime-bundle.ts';

describe('runtime bundle normalization', () => {
  it('keeps esbuild node_modules labels stable across symlinked and clean installs', () => {
    const bundle = [
      '// ../circuit/node_modules/commander/lib/error.js',
      'var require_error = __commonJS({',
      '  "../circuit/node_modules/commander/lib/error.js"(exports) {',
      '    exports.ok = true;',
      '  }',
      '});',
      'const literal = "../circuit/node_modules/kept-as-runtime-text";',
      '',
    ].join('\n');

    expect(normalizeRuntimeBundle(bundle)).toBe(
      [
        '// node_modules/commander/lib/error.js',
        'var require_error = __commonJS({',
        '  "node_modules/commander/lib/error.js"(exports) {',
        '    exports.ok = true;',
        '  }',
        '});',
        'const literal = "../circuit/node_modules/kept-as-runtime-text";',
        '',
      ].join('\n'),
    );
  });

  it('normalizes async __esm module labels built from a worktree (../../ prefix)', () => {
    // A worktree with no local node_modules resolves deps from the parent
    // checkout at ../../node_modules, so esbuild stamps its lazy-ESM wrappers
    // (the `async "..."()` shape) with that prefix. The bundle must normalize
    // to the same text a repo-root build produces, or the committed artifact
    // drifts from CI's clean `npm ci` rebuild.
    const bundle = [
      '// ../../node_modules/ink/build/dom.js',
      'var init_dom = __esm({',
      '  async "../../node_modules/ink/build/dom.js"() {',
      '    "use strict";',
      '  }',
      '});',
      '',
    ].join('\n');

    expect(normalizeRuntimeBundle(bundle)).toBe(
      [
        '// node_modules/ink/build/dom.js',
        'var init_dom = __esm({',
        '  async "node_modules/ink/build/dom.js"() {',
        '    "use strict";',
        '  }',
        '});',
        '',
      ].join('\n'),
    );
  });
});
