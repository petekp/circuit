import { describe, expect, it } from 'vitest';
import { validateFlowStartTarget } from '../../src/flows/registries/start-preflight.js';

describe('validateFlowStartTarget', () => {
  it('leaves flows that do not select a target alone', () => {
    expect(() => validateFlowStartTarget('build', 'review this pull request')).not.toThrow();
  });

  describe('when the goal is the only statement of the target', () => {
    it('refuses a goal naming two targets', () => {
      expect(() =>
        validateFlowStartTarget('review', 'review latest commit and staged changes'),
      ).toThrow(/pins one target per run/iu);
    });

    it('refuses a goal naming a pull request', () => {
      expect(() => validateFlowStartTarget('review', 'review this pull request')).toThrow(
        /cannot fetch a pull request/iu,
      );
    });

    it('accepts a goal the grammar does not recognise', () => {
      expect(() =>
        validateFlowStartTarget('review', 'review whatever you think matters'),
      ).not.toThrow();
    });
  });

  // The caller who passes --target has already decided. The gate has to read
  // the same input the intake writer reads, or it refuses runs the writer
  // would have served: the writer never consults prose once a target is named.
  describe('when a target is named', () => {
    it('does not refuse a goal that mentions a pull request', () => {
      expect(() =>
        validateFlowStartTarget('review', 'review the PR I just pushed', 'main...HEAD'),
      ).not.toThrow();
    });

    it('does not refuse a goal that mentions a second target', () => {
      expect(() =>
        validateFlowStartTarget('review', 'review latest commit and staged changes', 'staged'),
      ).not.toThrow();
    });

    it('does not refuse a goal that merely says the word pr in passing', () => {
      expect(() =>
        validateFlowStartTarget('review', 'review the staged changes before I open a pr', 'staged'),
      ).not.toThrow();
    });

    it('does not refuse a goal whose supplied material never arrives', () => {
      expect(() =>
        validateFlowStartTarget('review', 'review the following plan:', 'working-tree'),
      ).not.toThrow();
    });

    // Explicit but malformed still fails closed. The caller stated a target
    // and got it wrong; guessing past that would review something they did not
    // ask for.
    it('refuses a named target that cannot be read', () => {
      expect(() => validateFlowStartTarget('review', 'review my changes', 'commit:')).toThrow(
        /names no commit/iu,
      );
    });

    it('refuses an empty named target', () => {
      expect(() => validateFlowStartTarget('review', 'review my changes', '   ')).toThrow(
        /--target was empty/iu,
      );
    });
  });
});
