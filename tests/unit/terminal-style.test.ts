import { describe, expect, it } from 'vitest';
import { colorEnabled, composePaints, terminalPalette } from '../../src/cli/terminal-style.js';

// Styling is presentation only: with color disabled every paint function must
// return its input byte-for-byte, so pipes, tests, and NO_COLOR users see the
// exact same characters. Detection follows the de facto standards (NO_COLOR
// wins, then FORCE_COLOR, then TERM=dumb, then TTY).

const ESC = String.fromCharCode(27);

function tty(isTTY: boolean | undefined): { isTTY?: boolean } {
  return isTTY === undefined ? {} : { isTTY };
}

describe('colorEnabled', () => {
  it('NO_COLOR disables color even on a forced TTY', () => {
    expect(colorEnabled({ NO_COLOR: '1', FORCE_COLOR: '1' }, tty(true))).toBe(false);
  });

  it('FORCE_COLOR enables color without a TTY', () => {
    expect(colorEnabled({ FORCE_COLOR: '1' }, tty(undefined))).toBe(true);
  });

  it('FORCE_COLOR=0 does not force color on', () => {
    expect(colorEnabled({ FORCE_COLOR: '0' }, tty(undefined))).toBe(false);
  });

  it('TERM=dumb disables color on a TTY', () => {
    expect(colorEnabled({ TERM: 'dumb' }, tty(true))).toBe(false);
  });

  it('a plain TTY gets color; a pipe does not', () => {
    expect(colorEnabled({}, tty(true))).toBe(true);
    expect(colorEnabled({}, tty(undefined))).toBe(false);
  });
});

describe('terminalPalette', () => {
  it('disabled palette is the identity on every paint function', () => {
    const p = terminalPalette(false, {});
    const paints = [p.bold, p.dim, p.warn, p.accent, p.role('reviewer'), p.provider('anthropic')];
    for (const paint of paints) {
      expect(paint('sonnet')).toBe('sonnet');
    }
  });

  it('enabled palette wraps text in ANSI escapes and resets', () => {
    const p = terminalPalette(true, {});
    expect(p.bold('fix')).toBe(`${ESC}[1mfix${ESC}[0m`);
    expect(p.dim('power-tier')).toContain(`${ESC}[2m`);
  });

  it('accent uses truecolor when COLORTERM supports it, cyan otherwise', () => {
    const truecolor = terminalPalette(true, { COLORTERM: 'truecolor' });
    expect(truecolor.accent('◆')).toContain('38;2;');
    const basic = terminalPalette(true, {});
    expect(basic.accent('◆')).toContain(`${ESC}[36m`);
  });

  it('roles paint consistently and unknown roles pass through', () => {
    const p = terminalPalette(true, {});
    expect(p.role('researcher')('x')).toContain(`${ESC}[36m`);
    expect(p.role('implementer')('x')).toContain(`${ESC}[32m`);
    expect(p.role('reviewer')('x')).toContain(`${ESC}[35m`);
    expect(p.role('mystery')('x')).toBe('x');
  });

  it('providers get brand hues on truecolor terminals', () => {
    const p = terminalPalette(true, { COLORTERM: 'truecolor' });
    expect(p.provider('anthropic')('opus')).toContain('38;2;217;119;87');
    expect(p.provider('openai')('gpt-5.5')).toContain('38;2;88;166;255');
  });

  it('provider hue degrades to plain without truecolor, and unknown providers pass through', () => {
    const basic = terminalPalette(true, {});
    expect(basic.provider('anthropic')('opus')).toBe('opus');
    const truecolor = terminalPalette(true, { COLORTERM: 'truecolor' });
    expect(truecolor.provider('mystery')('m1')).toBe('m1');
    expect(truecolor.provider(undefined)('(none)')).toBe('(none)');
  });
});

describe('composePaints', () => {
  it('layers paints so the text carries every style', () => {
    const p = terminalPalette(true, { COLORTERM: 'truecolor' });
    const boldClay = composePaints(p.bold, p.provider('anthropic'))('opus');
    expect(boldClay).toContain(`${ESC}[1m`);
    expect(boldClay).toContain('38;2;217;119;87');
    expect(boldClay.endsWith(`${ESC}[0m`)).toBe(true);
  });

  it('composing identities stays the identity', () => {
    const p = terminalPalette(false, {});
    expect(composePaints(p.bold, p.provider('anthropic'))('opus')).toBe('opus');
  });
});
