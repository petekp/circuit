// ANSI styling for CLI output. Styling is presentation only: with color
// disabled every paint function returns its input unchanged, so pipes, tests,
// and NO_COLOR users see the exact same characters the renderer produced.
// Detection follows the de facto standards: NO_COLOR always wins, FORCE_COLOR
// (non-zero) forces color on, TERM=dumb disables, otherwise color requires a
// TTY. Renderers must pad on raw text width and style afterwards — escape
// sequences have no visible width.

const ESC = '\u001b[';
const RESET = `${ESC}0m`;

export type Paint = (text: string) => string;

export interface TerminalPalette {
  readonly bold: Paint;
  readonly dim: Paint;
  readonly warn: Paint;
  /** Brand accent: Circuit emerald on truecolor terminals, cyan elsewhere. */
  readonly accent: Paint;
  /** Consistent per-role color so roles read the same on every surface. */
  role(role: string): Paint;
  /**
   * Model text is hued by the provider that serves it. Truecolor only: the
   * hues are picked against the rest of the table (OpenAI's brand teal would
   * collide with the accent and the implementer green, so OpenAI is blue),
   * and there is no safe distinct pair left in the basic 8-color set.
   */
  provider(provider: string | undefined): Paint;
}

/** Layer paints (e.g. bold + provider hue); composing identities stays identity. */
export function composePaints(outer: Paint, inner: Paint): Paint {
  return (text) => outer(inner(text));
}

type EnvSlice = Readonly<
  Partial<Record<'NO_COLOR' | 'FORCE_COLOR' | 'TERM' | 'COLORTERM', string>>
>;

export function colorEnabled(
  env: EnvSlice = process.env,
  stream: { isTTY?: boolean } = process.stdout,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') {
    return true;
  }
  if (env.TERM === 'dumb') return false;
  return stream.isTTY === true;
}

const identity: Paint = (text) => text;

function painter(code: string): Paint {
  return (text) => `${ESC}${code}m${text}${RESET}`;
}

// Circuit's brand emerald (hue 163) for terminals that speak 24-bit color.
const ACCENT_TRUECOLOR = '38;2;16;185;129';
const ACCENT_FALLBACK = '36';

const ROLE_CODES: Readonly<Record<string, string>> = {
  researcher: '36',
  implementer: '32',
  reviewer: '35',
};

// Anthropic gets its brand clay. OpenAI is deliberately NOT its brand teal:
// that teal sits on top of both the Circuit emerald accent and the
// implementer green, so OpenAI takes blue — the one cool hue this table
// leaves unused.
const PROVIDER_CODES: Readonly<Record<string, string>> = {
  anthropic: '38;2;217;119;87',
  openai: '38;2;88;166;255',
};

export function terminalPalette(enabled: boolean, env: EnvSlice = process.env): TerminalPalette {
  if (!enabled) {
    return {
      bold: identity,
      dim: identity,
      warn: identity,
      accent: identity,
      role: () => identity,
      provider: () => identity,
    };
  }
  const colorterm = env.COLORTERM ?? '';
  const truecolor = colorterm.includes('truecolor') || colorterm.includes('24bit');
  const accentCode = truecolor ? ACCENT_TRUECOLOR : ACCENT_FALLBACK;
  return {
    bold: painter('1'),
    dim: painter('2'),
    warn: painter('33'),
    accent: painter(accentCode),
    role: (role) => {
      const code = ROLE_CODES[role];
      return code === undefined ? identity : painter(code);
    },
    provider: (provider) => {
      if (!truecolor || provider === undefined) return identity;
      const code = PROVIDER_CODES[provider];
      return code === undefined ? identity : painter(code);
    },
  };
}
