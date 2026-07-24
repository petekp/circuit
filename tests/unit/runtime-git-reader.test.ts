import { describe, expect, it } from 'vitest';

import { runtimeGitSpawnErrorAllowsPartialOutput } from '../../src/shared/runtime-git-reader.js';

describe('runtime Git reader helpers', () => {
  it('allows partial output only for the explicit max-buffer error', () => {
    expect(runtimeGitSpawnErrorAllowsPartialOutput({ code: 'ENOBUFS' })).toBe(true);
    expect(runtimeGitSpawnErrorAllowsPartialOutput({ code: 'ETIMEDOUT' })).toBe(false);
    expect(runtimeGitSpawnErrorAllowsPartialOutput({ code: 'EACCES' })).toBe(false);
    expect(runtimeGitSpawnErrorAllowsPartialOutput(new Error('arbitrary spawn failure'))).toBe(
      false,
    );
  });
});
