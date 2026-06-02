import { describe, expect, it } from 'vitest';

import { ProgressEvent } from '../../../src/schemas/progress-event.js';
import {
  type StatusBlockLine,
  renderStatusBlocks,
  statusBlockLineFromProgressEvent,
} from '../../../src/shared/status-block-renderer.js';

const RUN_ID = '87000000-0000-0000-0000-000000000001';

function routeEvent(input: {
  readonly blockId?: string;
  readonly lineMode: 'append' | 'replace_slot' | 'suppress';
  readonly statusText?: string;
  readonly slotId?: string;
}) {
  return ProgressEvent.parse({
    schema_version: 1,
    type: 'route.selected',
    run_id: RUN_ID,
    flow_id: 'review',
    recorded_at: '2026-05-07T12:00:00.000Z',
    label: 'Selected review',
    display: {
      text: 'Circuit selected review.',
      importance: 'major',
      tone: 'info',
    },
    presentation: {
      block_id: input.blockId ?? RUN_ID,
      line_mode: input.lineMode,
      ...(input.statusText === undefined ? {} : { status_text: input.statusText }),
      ...(input.slotId === undefined ? {} : { slot_id: input.slotId }),
    },
    selected_flow: 'review',
    routed_by: 'explicit',
    router_reason: 'explicit flow positional argument',
  });
}

describe('status block renderer', () => {
  it('keeps start and completion lines in append transcript mode', () => {
    const lines: StatusBlockLine[] = [
      { blockId: RUN_ID, lineMode: 'append', statusText: 'Chose review.', depth: 0 },
      {
        blockId: RUN_ID,
        lineMode: 'replace_slot',
        slotId: 'review-relay',
        statusText: 'Running review...',
        depth: 0,
      },
      {
        blockId: RUN_ID,
        lineMode: 'replace_slot',
        slotId: 'review-relay',
        statusText: 'Review completed.',
        depth: 0,
      },
    ];

    expect(renderStatusBlocks(lines, { mode: 'append-transcript' })).toBe(
      ['CIRCUIT', '⎿ Chose review.', '⎿ Running review...', '⎿ Review completed.', ''].join('\n'),
    );
  });

  it('replaces lines with the same slot in live snapshot mode', () => {
    const lines: StatusBlockLine[] = [
      { blockId: RUN_ID, lineMode: 'append', statusText: 'Chose review.', depth: 0 },
      {
        blockId: RUN_ID,
        lineMode: 'replace_slot',
        slotId: 'review-relay',
        statusText: 'Running review...',
        depth: 0,
      },
      {
        blockId: RUN_ID,
        lineMode: 'replace_slot',
        slotId: 'review-relay',
        statusText: 'Review completed.',
        depth: 0,
      },
    ];

    expect(renderStatusBlocks(lines, { mode: 'live-snapshot' })).toBe(
      ['CIRCUIT', '⎿ Chose review.', '⎿ Review completed.', ''].join('\n'),
    );
  });

  it('creates separate blocks for separate top-level command ids', () => {
    const lines: StatusBlockLine[] = [
      { blockId: 'build-run', lineMode: 'append', statusText: 'Chose build.', depth: 0 },
      {
        blockId: 'build-run',
        lineMode: 'replace_slot',
        slotId: 'checkpoint',
        statusText: 'Waiting for your choice...',
        depth: 0,
      },
      {
        blockId: 'handoff-run',
        lineMode: 'append',
        statusText: 'Chose handoff save.',
        depth: 0,
      },
      {
        blockId: 'handoff-run',
        lineMode: 'replace_slot',
        slotId: 'handoff',
        statusText: 'Handoff saved.',
        depth: 0,
      },
    ];

    expect(renderStatusBlocks(lines, { mode: 'live-snapshot' })).toBe(
      [
        'CIRCUIT',
        '⎿ Chose build.',
        '⎿ Waiting for your choice...',
        '',
        'CIRCUIT',
        '⎿ Chose handoff save.',
        '⎿ Handoff saved.',
        '',
      ].join('\n'),
    );
  });

  it('does not emit a bare status line before a block header', () => {
    const rendered = renderStatusBlocks(
      [{ blockId: RUN_ID, lineMode: 'append', statusText: 'Framing the work...', depth: 0 }],
      { mode: 'append-transcript' },
    );

    expect(rendered.startsWith('CIRCUIT\n⎿ Framing the work...')).toBe(true);
    expect(rendered.startsWith('⎿')).toBe(false);
  });

  it('projects real progress events only from presentation metadata', () => {
    const visible = statusBlockLineFromProgressEvent(
      routeEvent({ lineMode: 'append', statusText: 'Chose review.' }),
    );
    const suppressed = statusBlockLineFromProgressEvent(routeEvent({ lineMode: 'suppress' }));

    expect(visible).toEqual({
      blockId: RUN_ID,
      lineMode: 'append',
      statusText: 'Chose review.',
      depth: 0,
    });
    expect(suppressed).toBeUndefined();
  });
});
