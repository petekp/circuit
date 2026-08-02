// `circuit reclaim` accepted a --json flag and then printed JSON no matter
// who asked, so a person at a terminal read a machine payload and the flag
// that would have requested it did nothing.
import { describe, expect, it } from 'vitest';
import { renderReclaimSummary } from '../../src/cli/reclaim.js';
import { terminalPalette } from '../../src/cli/terminal-style.js';

const PALETTE = terminalPalette(false);
const ROOT = '/repo/.circuit/worktrees';

describe('what reclaim tells a person', () => {
  it('says plainly when there was nothing to reclaim', () => {
    const text = renderReclaimSummary(PALETTE, {
      worktreesRoot: ROOT,
      removed: [],
      kept: [],
      errors: [],
    });
    expect(text).toContain('circuit reclaim');
    expect(text).toContain('Nothing to reclaim');
    expect(text).toContain(ROOT);
    expect(text).not.toContain('{');
  });

  it('counts what it removed and what it left alone', () => {
    const text = renderReclaimSummary(PALETTE, {
      worktreesRoot: ROOT,
      removed: [`${ROOT}/run-a/unit-1`, `${ROOT}/run-a/unit-2`],
      kept: [`${ROOT}/run-b/unit-1`],
      errors: [],
    });
    expect(text).toContain('Removed 2');
    expect(text).toContain('Kept 1');
    expect(text).toContain('run-a/unit-2');
    expect(text).toContain('still running');
  });

  it('shows a worktree it could not remove, with the reason', () => {
    const text = renderReclaimSummary(PALETTE, {
      worktreesRoot: ROOT,
      removed: [],
      kept: [],
      errors: [{ path: `${ROOT}/run-c/unit-1`, message: 'git worktree remove failed' }],
    });
    expect(text).toContain('Could not remove 1');
    expect(text).toContain('git worktree remove failed');
  });
});
