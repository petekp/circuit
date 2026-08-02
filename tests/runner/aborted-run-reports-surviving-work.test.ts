// A run that dies partway must hand over the work it already did.
//
// The corpus case this exists for: a Build run wrote brief.json, plan.json,
// baseline-snapshot.json, implementation.json and verification.json, then its
// act-step ran out of retries. Everything above was on disk and correct. What
// the operator was told was "Failed: build stopped before finishing its
// process", followed by "Address the reason above, then rerun" — rerun from
// nothing, as though the plan and the implementation did not exist.
//
// The engine already knows exactly what survived: every report a step writes
// appends a `step.report_written` trace entry carrying its path and schema.
// Nothing read them. This is the guard on reading them.
//
// The guarantee is engine-owned and stated over the close path itself, not over
// any one flow, because the whole point is that a flow added later inherits it
// without its author doing anything.
import { describe, expect, it } from 'vitest';

import type { TraceEntry } from '../../src/runtime/domain/trace.js';
import { closeRun } from '../../src/runtime/run/run-close.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';

const RUN_ID = '9b000000-0000-0000-0000-0000000000a1';

function reportWritten(
  stepId: string,
  reportPath: string,
  reportSchema: string,
  attempt = 1,
): TraceEntry {
  return {
    schema_version: 1,
    sequence: 0,
    recorded_at: '2026-08-02T00:00:00.000Z',
    run_id: RUN_ID,
    kind: 'step.report_written',
    step_id: stepId,
    attempt,
    report_path: reportPath,
    report_schema: reportSchema,
  } as unknown as TraceEntry;
}

function closeContext(entries: readonly TraceEntry[]): {
  context: RunContext;
  written: { path: string; value: unknown }[];
} {
  const written: { path: string; value: unknown }[] = [];
  const context = {
    flow: { id: 'build' },
    runId: RUN_ID,
    goal: 'combine the two tournament flags into one',
    manifestHash: 'h'.repeat(64),
    now: () => new Date(Date.UTC(2026, 7, 2, 12, 0, 0)),
    trace: { getAll: () => entries, append: async () => undefined },
    files: {
      writeJson: async (path: string, value: unknown) => {
        written.push({ path, value });
        return path;
      },
      readJson: async () => {
        throw new Error('ENOENT');
      },
    },
  } as unknown as RunContext;
  return { context, written };
}

const BUILD_TRACE: readonly TraceEntry[] = [
  reportWritten('frame-step', 'reports/build/brief.json', 'build.brief@v1'),
  reportWritten('plan-step', 'reports/build/plan.json', 'build.plan@v1'),
  reportWritten('build-baseline', 'reports/build/baseline-snapshot.json', 'build.baseline@v1'),
  reportWritten('verify-step', 'reports/build/verification.json', 'build.verification@v1', 1),
  reportWritten('verify-step', 'reports/build/verification.json', 'build.verification@v1', 2),
];

describe('an aborted run hands over the work that survived it', () => {
  it('records every report that was written, deduped to the last attempt', async () => {
    const { context } = closeContext(BUILD_TRACE);

    const closed = await closeRun(context, 'aborted', undefined, "route 'retry' exhausted");

    expect(closed.result.surviving_work?.map((item) => item.report_path)).toEqual([
      'reports/build/brief.json',
      'reports/build/plan.json',
      'reports/build/baseline-snapshot.json',
      'reports/build/verification.json',
    ]);
    // The step that produced each one, so the operator can tell a plan from a
    // baseline without opening five files.
    expect(closed.result.surviving_work?.[1]).toMatchObject({
      step_id: 'plan-step',
      report_path: 'reports/build/plan.json',
    });
    // verification.json was written twice. It appears once, at the attempt that
    // actually left the file on disk.
    const verification = closed.result.surviving_work?.filter(
      (item) => item.report_path === 'reports/build/verification.json',
    );
    expect(verification).toHaveLength(1);
    expect(verification?.[0]?.attempt).toBe(2);
  });

  it('tells the operator what is on disk instead of implying a rerun from nothing', async () => {
    const { context } = closeContext(BUILD_TRACE);

    const closed = await closeRun(context, 'aborted', undefined, "route 'retry' exhausted");

    // The count and at least one real path, so the sentence is checkable
    // against the folder rather than a vague reassurance.
    expect(closed.result.summary).toContain('reports/build/plan.json');
    expect(closed.result.summary).toMatch(/\b4\b/);
    expect(closed.result.summary.toLowerCase()).toContain('nothing was deleted');
  });

  it('claims nothing when nothing was written', async () => {
    // An abort before any step produced a report is a genuinely empty abort.
    // Inventing a salvage line here would be the same class of lie the honesty
    // floor exists to stop, pointed the other way.
    const { context } = closeContext([]);

    const closed = await closeRun(context, 'aborted', undefined, 'connector never answered');

    expect(closed.result.surviving_work).toBeUndefined();
    expect(closed.result.summary.toLowerCase()).not.toContain('nothing was deleted');
  });

  it('stays off a clean complete, where the primary result already speaks', async () => {
    const { context } = closeContext(BUILD_TRACE);

    const closed = await closeRun(context, 'complete', '@complete');

    expect(closed.result.outcome).toBe('complete');
    expect(closed.result.surviving_work).toBeUndefined();
    expect(closed.result.summary).not.toContain('reports/build/plan.json');
  });

  it('hands over on a stopped close too, not only an abort', async () => {
    // `stopped` is the honest degraded close the terminal-outcome bind produces.
    // The work that reached disk before it is exactly as worth keeping.
    const { context } = closeContext(BUILD_TRACE);

    const closed = await closeRun(context, 'stopped', '@stop', 'review rejected the change');

    expect(closed.result.surviving_work).toHaveLength(4);
    expect(closed.result.summary).toContain('reports/build/plan.json');
  });
});
