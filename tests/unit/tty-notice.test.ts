import { describe, expect, it } from 'vitest';

import {
  checkpointWaitingNotice,
  runFinishedNotice,
  runStartedNotice,
  ttyNoticesEnabled,
} from '../../src/cli/tty-notice.js';

// Human-facing status lines for interactive terminals (checkpoint UX audit,
// finding 4: a multi-minute run is totally silent today unless --progress
// jsonl is on). The stdout JSON envelope is a test-locked contract, so these
// lines go to stderr and only when stderr is a real terminal. The builders
// are pure so the TTY gate stays one thin call site in run.ts.

describe('ttyNoticesEnabled', () => {
  it('is on only for a real terminal without machine progress output', () => {
    expect(ttyNoticesEnabled({ stream: { isTTY: true }, progressJsonl: false })).toBe(true);
    expect(ttyNoticesEnabled({ stream: { isTTY: false }, progressJsonl: false })).toBe(false);
    expect(ttyNoticesEnabled({ stream: {}, progressJsonl: false })).toBe(false);
    expect(ttyNoticesEnabled({ stream: { isTTY: true }, progressJsonl: true })).toBe(false);
  });
});

describe('runStartedNotice', () => {
  it('names the flow, the mode, and where reports land', () => {
    const line = runStartedNotice({
      flowName: 'prototype',
      entryModeName: 'tournament',
      runFolder: '/work/.circuit/runs/abc',
    });
    expect(line).toContain('prototype');
    expect(line).toContain('tournament');
    expect(line).toContain('/work/.circuit/runs/abc/reports');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('omits the mode cleanly when none was selected', () => {
    const line = runStartedNotice({ flowName: 'fix', runFolder: '/rf' });
    expect(line).toContain('fix');
    expect(line).not.toContain('undefined');
  });
});

describe('checkpointWaitingNotice', () => {
  it('says the run is waiting, lists the choices, and shows the resume command', () => {
    const line = checkpointWaitingNotice({
      runFolder: '/rf',
      choices: ['keep-prototype', 'discard-prototype'],
      summaryHtmlPath: '/rf/reports/operator-summary.html',
    });
    expect(line.toLowerCase()).toContain('waiting');
    expect(line).toContain('keep-prototype, discard-prototype');
    expect(line).toContain('circuit resume --run-folder /rf --checkpoint-choice');
    expect(line).toContain('/rf/reports/operator-summary.html');
  });

  it('leaves the decision page line out when there is no page', () => {
    const line = checkpointWaitingNotice({ runFolder: '/rf', choices: ['go'] });
    expect(line).not.toContain('undefined');
  });
});

describe('runFinishedNotice', () => {
  it('names the outcome and points at the reports folder', () => {
    const line = runFinishedNotice({ outcome: 'complete', runFolder: '/rf' });
    expect(line).toContain('complete');
    expect(line).toContain('/rf/reports');
    expect(line.endsWith('\n')).toBe(true);
  });
});
