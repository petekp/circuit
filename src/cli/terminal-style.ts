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
  /** Effort as typographic weight: high bold, low dim, medium plain. */
  effort(effort: string | undefined): Paint;
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

export function terminalPalette(enabled: boolean, env: EnvSlice = process.env): TerminalPalette {
  if (!enabled) {
    return {
      bold: identity,
      dim: identity,
      warn: identity,
      accent: identity,
      role: () => identity,
      effort: () => identity,
    };
  }
  const colorterm = env.COLORTERM ?? '';
  const accentCode =
    colorterm.includes('truecolor') || colorterm.includes('24bit')
      ? ACCENT_TRUECOLOR
      : ACCENT_FALLBACK;
  return {
    bold: painter('1'),
    dim: painter('2'),
    warn: painter('33'),
    accent: painter(accentCode),
    role: (role) => {
      const code = ROLE_CODES[role];
      return code === undefined ? identity : painter(code);
    },
    effort: (effort) => {
      if (effort === 'high') return painter('1');
      if (effort === 'low') return painter('2');
      return identity;
    },
  };
}
