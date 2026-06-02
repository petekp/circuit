import type { ProgressEvent } from '../schemas/progress-event.js';

export type StatusBlockRenderMode = 'append-transcript' | 'live-snapshot';

export interface StatusBlockLine {
  readonly blockId: string;
  readonly lineMode: 'append' | 'replace_slot';
  readonly slotId?: string;
  readonly statusText: string;
  readonly depth: number;
}

export function statusBlockLineFromProgressEvent(
  event: Pick<ProgressEvent, 'presentation'>,
): StatusBlockLine | undefined {
  const presentation = event.presentation;
  if (presentation === undefined || presentation.line_mode === 'suppress') return undefined;
  if (presentation.status_text === undefined) return undefined;
  if (presentation.line_mode === 'replace_slot' && presentation.slot_id === undefined) {
    return undefined;
  }
  return {
    blockId: presentation.block_id,
    lineMode: presentation.line_mode,
    ...(presentation.slot_id === undefined ? {} : { slotId: presentation.slot_id }),
    statusText: presentation.status_text,
    depth: presentation.depth ?? 0,
  };
}

export function renderStatusLine(line: StatusBlockLine): string {
  const indent = line.depth > 0 ? '  '.repeat(line.depth) : '';
  return `${indent}⎿ ${line.statusText}`;
}

function lineKey(line: StatusBlockLine, index: number): string {
  if (line.lineMode !== 'replace_slot') return `append:${index}`;
  return `slot:${line.slotId}`;
}

function liveSnapshotLines(lines: readonly StatusBlockLine[]): StatusBlockLine[] {
  const ordered: StatusBlockLine[] = [];
  const indexesByKey = new Map<string, number>();

  for (const [index, line] of lines.entries()) {
    const key = lineKey(line, index);
    const existingIndex = indexesByKey.get(key);
    if (existingIndex === undefined) {
      indexesByKey.set(key, ordered.length);
      ordered.push(line);
      continue;
    }
    ordered[existingIndex] = line;
  }

  return ordered;
}

export function renderStatusBlocks(
  lines: readonly StatusBlockLine[],
  input: {
    readonly mode: StatusBlockRenderMode;
    readonly title?: string;
  },
): string {
  const title = input.title ?? 'CIRCUIT';
  const blockOrder: string[] = [];
  const linesByBlock = new Map<string, StatusBlockLine[]>();

  for (const line of lines) {
    if (!linesByBlock.has(line.blockId)) {
      blockOrder.push(line.blockId);
      linesByBlock.set(line.blockId, []);
    }
    linesByBlock.get(line.blockId)?.push(line);
  }

  const output: string[] = [];
  for (const blockId of blockOrder) {
    const blockLines = linesByBlock.get(blockId) ?? [];
    if (blockLines.length === 0) continue;
    if (output.length > 0) output.push('');
    output.push(title);
    const visibleLines =
      input.mode === 'live-snapshot' ? liveSnapshotLines(blockLines) : blockLines;
    for (const line of visibleLines) output.push(renderStatusLine(line));
  }

  return output.length === 0 ? '' : `${output.join('\n')}\n`;
}
