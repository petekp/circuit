import { describe, expect, it } from 'vitest';
import { REQUIRED_NODE, nodeVersionError } from '../../bin/node-version-guard.js';

// The guard is the one piece of circuit that must run on a too-old Node, so it
// lives as plain JavaScript in bin/. These tests cover the pure comparison so
// the shipped entry-point behavior is proven, not just asserted.
describe('nodeVersionError', () => {
  it('rejects a Node below the required minor with a legible message naming both versions', () => {
    const message = nodeVersionError('22.17.0', REQUIRED_NODE);
    expect(message).toBeDefined();
    expect(message).toContain('22.18');
    expect(message).toContain('22.17.0');
  });

  it('rejects a Node below the required major', () => {
    const message = nodeVersionError('20.11.1', { major: 22, minor: 18 });
    expect(message).toBeDefined();
    expect(message).toContain('20.11.1');
  });

  it('accepts the exact required version', () => {
    expect(nodeVersionError('22.18.0', REQUIRED_NODE)).toBeUndefined();
  });

  it('accepts a newer minor and a newer major', () => {
    expect(nodeVersionError('22.20.0', REQUIRED_NODE)).toBeUndefined();
    expect(nodeVersionError('24.3.0', REQUIRED_NODE)).toBeUndefined();
  });

  // Node's unflagged built-in TypeScript type-stripping — which circuit's `.ts`
  // entry points require — arrived on the 22.x LTS line at 22.18 but on the
  // 23.x "Current" line not until 23.6. A Node in the 23.0–23.5 window clears a
  // naive "newer than the required major" check yet still crashes on the first
  // `.ts` import with a raw, illegible error, which is exactly the class this
  // guard exists to turn into a legible message.
  it('rejects the 23.0–23.5 window where native .ts import still crashes', () => {
    for (const version of ['23.0.0', '23.2.1', '23.5.0']) {
      const message = nodeVersionError(version, REQUIRED_NODE);
      expect(message, version).toBeDefined();
      expect(message, version).toContain(version);
      expect(message, version).toContain('23.6');
    }
  });

  it('accepts 23.6 and newer on the 23.x line', () => {
    expect(nodeVersionError('23.6.0', REQUIRED_NODE)).toBeUndefined();
    expect(nodeVersionError('23.11.0', REQUIRED_NODE)).toBeUndefined();
  });

  it('does not block when the version string is unparseable', () => {
    expect(nodeVersionError('not-a-version', REQUIRED_NODE)).toBeUndefined();
  });
});
