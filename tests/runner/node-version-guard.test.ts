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

  it('does not block when the version string is unparseable', () => {
    expect(nodeVersionError('not-a-version', REQUIRED_NODE)).toBeUndefined();
  });
});
