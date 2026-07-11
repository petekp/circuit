// Shared CLI table rendering — the accent-diamond header line and the padded,
// styled table body used by both `circuit preview` and `circuit doctor`. A
// table cell carries its raw text plus an optional paint. Widths are computed
// on raw text and styling is applied afterwards, because ANSI escape
// sequences have no visible width and would wreck column alignment.
import type { Paint, TerminalPalette } from './terminal-style.js';

export interface Cell {
  readonly text: string;
  readonly paint?: Paint;
}
export type TableRow = readonly Cell[] | 'rule' | 'gap';

export function cell(text: string, paint?: Paint): Cell {
  return paint === undefined ? { text } : { text, paint };
}

export function renderStyledTable(palette: TerminalPalette, rows: readonly TableRow[]): string {
  const dataRows = rows.filter((row): row is readonly Cell[] => Array.isArray(row));
  const widths: number[] = [];
  for (const row of dataRows) {
    row.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, c.text.length);
    });
  }
  const tableWidth = widths.reduce((sum, w) => sum + w, 0) + 2 * Math.max(0, widths.length - 1);
  return rows
    .map((row) => {
      if (row === 'gap') return '';
      if (row === 'rule') return palette.dim('─'.repeat(tableWidth));
      return row
        .map((c, i) => {
          const spaces = ' '.repeat(Math.max(0, (widths[i] ?? 0) - c.text.length));
          const painted = c.text === '' || c.paint === undefined ? c.text : c.paint(c.text);
          return painted + spaces;
        })
        .join('  ')
        .trimEnd();
    })
    .join('\n');
}

// The accent diamond header line every readout opens with: `◆ <command>`,
// optionally followed by dim-separated parts (subject, dial, etc).
export function diamondHeaderLine(
  palette: TerminalPalette,
  command: string,
  parts: readonly string[] = [],
): string {
  const sep = palette.dim('·');
  const segments = [palette.bold(command), ...parts];
  return `${palette.accent('◆')} ${segments.join(` ${sep} `)}`;
}

export function columnHeader(palette: TerminalPalette, labels: readonly string[]): readonly Cell[] {
  return labels.map((label) => cell(label, palette.dim));
}
