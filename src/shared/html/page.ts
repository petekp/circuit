// Shared text primitives for operator-summary pages.
//
// Centralizes Unicode sanitization and length caps. Rendering and HTML
// escaping live in react-page.tsx (React escapes interpolated text); every
// operator-controlled string still passes through t(), which composes
// sanitizeForRender + truncate from here.

// Strip C0 controls (except \t \n \r), bidi overrides, and bidi isolates.
// These survive Zod string validation but distort visual rendering: a
// U+202E in an option label flips subsequent text right-to-left, which
// could deceive an operator about which option they are picking.
// Pattern is built from char-code ranges to keep this source file free of
// literal control characters.
function buildSanitizePattern(): RegExp {
  const ranges: ReadonlyArray<readonly [number, number]> = [
    [0x00, 0x08],
    [0x0b, 0x0c],
    [0x0e, 0x1f],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
  ];
  const klass = ranges
    .map(([lo, hi]) => {
      const loEsc = `\\u${lo.toString(16).padStart(4, '0')}`;
      const hiEsc = `\\u${hi.toString(16).padStart(4, '0')}`;
      return `${loEsc}-${hiEsc}`;
    })
    .join('');
  return new RegExp(`[${klass}]`, 'g');
}

const SANITIZE_PATTERN = buildSanitizePattern();

export const MAX_BULLET_LEN = 4096;
export const MAX_PROMPT_LEN = 32_768;

// Strip dangerous-but-validation-passing characters before rendering.
// React escapes HTML metacharacters on its own, but escaping is not
// sanitization: bidi overrides and C0 controls survive it.
export function sanitizeForRender(value: string): string {
  return value.replace(SANITIZE_PATTERN, '');
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
