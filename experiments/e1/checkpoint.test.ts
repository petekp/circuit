import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PREFERRED_CHECKPOINT_CHOICE,
  chooseCheckpointChoice,
  readCheckpointState,
} from './checkpoint.ts';
import { FIXTURES_ROOT } from './fixture.ts';

describe('chooseCheckpointChoice', () => {
  it('prefers the continue path when it is allowed', () => {
    expect(chooseCheckpointChoice(['continue'])).toBe('continue');
    expect(chooseCheckpointChoice(['revise', 'continue', 'stop'])).toBe('continue');
  });

  it('falls back to the first allowed choice when continue is not offered', () => {
    expect(chooseCheckpointChoice(['revise', 'stop'])).toBe('revise');
  });

  it('falls back to the preferred choice for the (schema-forbidden) empty case', () => {
    expect(chooseCheckpointChoice([])).toBe(PREFERRED_CHECKPOINT_CHOICE);
  });
});

describe('readCheckpointState', () => {
  it('detects a run parked at the build frame checkpoint and picks continue', () => {
    const state = readCheckpointState(join(FIXTURES_ROOT, 'separated-checkpoint-waiting'));
    expect(state.waiting).toBe(true);
    if (!state.waiting) throw new Error('expected waiting state');
    expect(state.stepId).toBe('frame-step');
    expect(state.allowedChoices).toEqual(['continue']);
    expect(state.choice).toBe('continue');
  });

  it('reports a terminal run (outcome complete) as not waiting', () => {
    // holistic-pass is a genuine finished run: its process-evidence outcome is
    // 'complete', so the harness treats the folder as terminal (no resume).
    const state = readCheckpointState(join(FIXTURES_ROOT, 'holistic-pass'));
    expect(state.waiting).toBe(false);
  });

  it('reports a missing run folder as not waiting', () => {
    const state = readCheckpointState(join(FIXTURES_ROOT, 'does-not-exist'));
    expect(state.waiting).toBe(false);
  });
});
