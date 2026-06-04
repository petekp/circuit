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
});
