import { describe, expect, it } from 'vitest';
import { CompiledDepth } from '../../src/index.js';

describe('smoke', () => {
  it('vitest runs and schemas import cleanly', () => {
    expect(CompiledDepth.options).toContain('high');
  });
});
