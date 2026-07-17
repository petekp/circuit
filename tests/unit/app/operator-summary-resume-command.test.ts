import { describe, expect, it } from 'vitest';

import { operatorSummaryResumeCommandPrefix } from '../../../src/app/operator-summary/resume-command.js';

describe('operator summary resume command', () => {
  it('uses the Claude plugin wrapper and presentation mode', () => {
    expect(
      operatorSummaryResumeCommandPrefix({
        hostKind: 'claude-code',
        pluginRoot: "/tmp/Circuit Pete's plugin",
        execPath: '/usr/local/bin/node',
        cliEntryPath: '/tmp/circuit/runtime/circuit.js',
      }),
    ).toBe(
      "'/usr/local/bin/node' '/tmp/Circuit Pete'\\''s plugin/scripts/circuit.js' present resume",
    );
  });

  it('uses the Codex plugin wrapper without presentation mode', () => {
    expect(
      operatorSummaryResumeCommandPrefix({
        hostKind: 'codex',
        pluginRoot: '/tmp/circuit-plugin',
        execPath: '/usr/local/bin/node',
        cliEntryPath: '/tmp/circuit/runtime/circuit.js',
      }),
    ).toBe("'/usr/local/bin/node' '/tmp/circuit-plugin/scripts/circuit.js' resume");
  });

  it('uses the exact local CLI entry instead of assuming circuit is on PATH', () => {
    expect(
      operatorSummaryResumeCommandPrefix({
        execPath: '/usr/local/bin/node',
        cliEntryPath: '/Users/pete/Code/circuit/bin/circuit',
      }),
    ).toBe("'/usr/local/bin/node' '/Users/pete/Code/circuit/bin/circuit' resume");
  });

  it('keeps the portable fallback when no executable identity is available', () => {
    expect(operatorSummaryResumeCommandPrefix({})).toBe('circuit resume');
  });
});
