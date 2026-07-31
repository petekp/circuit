import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { flowPackages } from '../../src/flows/catalog.js';
import type { CompiledFlowProgressSurface } from '../../src/flows/types.js';
import type { TraceEntry } from '../../src/runtime/domain/trace.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';
import { createProgressProjector } from '../../src/runtime/projections/progress.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { ProgressEvent } from '../../src/schemas/progress-event.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const RECORDED_AT = '2026-05-15T12:00:00.000Z';

function progressSurfaceFor(flowId: string): CompiledFlowProgressSurface {
  const surface = flowPackages.find((pkg) => pkg.id === flowId)?.runtimeSurface?.progress;
  if (surface === undefined) throw new Error(`missing ${flowId} progress surface`);
  return surface;
}

function generatedFlow(flowId: string) {
  const body = JSON.parse(readFileSync(resolve(`generated/flows/${flowId}/circuit.json`), 'utf8'));
  return fromCompiledFlow(CompiledFlow.parse(body));
}

// The progress projector reads each entry defensively (kind-narrowed field
// reads with fallbacks), so these fixtures are intentionally minimal per
// variant. They are fabricated as loose trace bodies and completed with the
// auto-filled run_id/recorded_at here, then handed to the projector as
// TraceEntry values.
function trace(
  entry: { readonly sequence: number; readonly kind: TraceEntry['kind'] } & Record<string, unknown>,
): TraceEntry {
  return {
    run_id: RUN_ID,
    recorded_at: RECORDED_AT,
    ...entry,
  } as unknown as TraceEntry;
}

function projectProgress(flowId: string, entries: readonly TraceEntry[]): ProgressEvent[] {
  const progress: ProgressEvent[] = [];
  const projector = createProgressProjector({
    progress: (event) => progress.push(event),
    runDir: '/tmp/circuit-progress-test',
    runId: RUN_ID,
    flow: generatedFlow(flowId),
    progressSurface: progressSurfaceFor(flowId),
  });
  for (const entry of entries) {
    projector(entry);
  }
  return progress;
}

describe('runtime progress projection', () => {
  it('keeps operator copy stable when schematic step titles change', () => {
    const body = JSON.parse(readFileSync(resolve('generated/flows/explore/circuit.json'), 'utf8'));
    for (const step of body.steps) {
      if (step.id === 'synthesize-step') {
        step.title = 'Compose — produce explore.compose (connector-bound relay)';
      }
    }

    const flow = fromCompiledFlow(CompiledFlow.parse(body));
    const progress: ProgressEvent[] = [];
    const projector = createProgressProjector({
      progress: (event) => progress.push(event),
      runDir: '/tmp/circuit-progress-test',
      runId: RUN_ID,
      flow,
      progressSurface: progressSurfaceFor('explore'),
    });

    projector(trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'explore' }));
    projector(trace({ sequence: 1, kind: 'step.entered', step_id: 'synthesize-step', attempt: 1 }));
    projector(
      trace({
        sequence: 2,
        kind: 'step.completed',
        step_id: 'synthesize-step',
        attempt: 1,
        route_taken: 'pass',
      }),
    );

    const visibleText = progress.map((event) => event.display.text).join('\n');
    expect(visibleText).toContain('Circuit: Drafting the recommendation...');
    expect(visibleText).toContain('Finished drafting the recommendation.');
    expect(visibleText).not.toContain('explore.compose');
    expect(visibleText).not.toContain('connector-bound relay');

    const taskLists = progress.filter((event) => event.type === 'task_list.updated');
    const lastTaskList = taskLists.at(-1);
    expect(lastTaskList?.tasks.find((task) => task.id === 'synthesize-step')).toMatchObject({
      title: 'Draft the recommendation',
      status: 'completed',
    });
  });

  it('keeps Explore relay started and completed copy stable', () => {
    const progress = projectProgress('explore', [
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'explore' }),
      trace({ sequence: 1, kind: 'step.entered', step_id: 'synthesize-step', attempt: 1 }),
      trace({
        sequence: 2,
        kind: 'relay.started',
        step_id: 'synthesize-step',
        role: 'implementer',
        connector: { kind: 'builtin', name: 'claude-code' },
      }),
      trace({
        sequence: 3,
        kind: 'relay.completed',
        step_id: 'synthesize-step',
        role: 'implementer',
        verdict: 'accept',
        duration_ms: 123,
      }),
    ]);

    expect(progress.find((event) => event.type === 'relay.started')?.display.text).toBe(
      'Circuit: Asking the specialist to draft the recommendation...',
    );
    expect(progress.find((event) => event.type === 'relay.started')?.presentation).toMatchObject({
      line_mode: 'replace_slot',
      slot_id: 'synthesize-step:relay',
      status_text: 'Asking the specialist to draft the recommendation...',
    });
    expect(progress.find((event) => event.type === 'relay.completed')?.display.text).toBe(
      'Circuit: Finished drafting the recommendation.',
    );
    expect(progress.find((event) => event.type === 'relay.completed')?.presentation).toMatchObject({
      line_mode: 'replace_slot',
      slot_id: 'synthesize-step:relay',
      status_text: 'Finished drafting the recommendation.',
    });
  });

  it('emits the relay.started progress line for the cursor-agent connector', () => {
    // Regression: connectorFromTrace previously recognized only claude-code
    // and codex as built-in connectors, so a cursor-agent relay silently
    // dropped its relay.started progress line that the other connectors emit.
    const progress = projectProgress('explore', [
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'explore' }),
      trace({ sequence: 1, kind: 'step.entered', step_id: 'synthesize-step', attempt: 1 }),
      trace({
        sequence: 2,
        kind: 'relay.started',
        step_id: 'synthesize-step',
        role: 'implementer',
        connector: { kind: 'builtin', name: 'cursor-agent' },
      }),
    ]);

    const relayStarted = progress.find((event) => event.type === 'relay.started');
    expect(relayStarted).toBeDefined();
    expect(relayStarted).toMatchObject({
      type: 'relay.started',
      role: 'implementer',
      connector_name: 'cursor-agent',
      connector_kind: 'builtin',
      filesystem_capability: 'trusted-write',
    });
    expect(relayStarted?.display.text).toBe(
      'Circuit: Asking the specialist to draft the recommendation...',
    );
  });

  it('locks fanout started/branch/joined progress derivations', () => {
    // Characterization: the fanout progress derivations (child_outcome,
    // policy, branch_kind, branch_ids) are only exercised through the
    // projector and were otherwise uncovered. This pins their current output
    // before centralizing the inline helpers behind shared accessors.
    const progress = projectProgress('explore', [
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'explore' }),
      trace({
        sequence: 1,
        kind: 'fanout.started',
        step_id: 'synthesize-step',
        branch_ids: ['option-1', 'option-2'],
      }),
      trace({
        sequence: 2,
        kind: 'fanout.branch_started',
        step_id: 'synthesize-step',
        branch_id: 'option-1',
        branch_kind: 'sub-run',
        child_run_id: '22222222-2222-4222-8222-222222222222',
        worktree_path: 'worktrees/option-1',
      }),
      trace({
        sequence: 3,
        kind: 'fanout.branch_completed',
        step_id: 'synthesize-step',
        branch_id: 'option-1',
        branch_kind: 'sub-run',
        child_run_id: '22222222-2222-4222-8222-222222222222',
        child_outcome: 'complete',
        verdict: 'accept',
        duration_ms: 42,
      }),
      trace({
        sequence: 4,
        kind: 'fanout.joined',
        step_id: 'synthesize-step',
        policy: 'pick-winner',
        selected_branch_id: 'option-1',
        aggregate_path: 'fanout/aggregate.json',
        branches_completed: 1,
        branches_failed: 1,
      }),
    ]);

    expect(progress.find((event) => event.type === 'fanout.started')).toMatchObject({
      type: 'fanout.started',
      branch_count: 2,
      branch_ids: ['option-1', 'option-2'],
    });
    expect(progress.find((event) => event.type === 'fanout.branch_started')).toMatchObject({
      type: 'fanout.branch_started',
      branch_id: 'option-1',
      branch_kind: 'sub-run',
      child_run_id: '22222222-2222-4222-8222-222222222222',
      worktree_path: 'worktrees/option-1',
    });
    expect(progress.find((event) => event.type === 'fanout.branch_completed')).toMatchObject({
      type: 'fanout.branch_completed',
      branch_id: 'option-1',
      branch_kind: 'sub-run',
      child_outcome: 'complete',
      verdict: 'accept',
      duration_ms: 42,
    });
    expect(progress.find((event) => event.type === 'fanout.joined')).toMatchObject({
      type: 'fanout.joined',
      policy: 'pick-winner',
      selected_branch_id: 'option-1',
      aggregate_path: 'fanout/aggregate.json',
      branches_completed: 1,
      branches_failed: 1,
    });
  });

  it('suppresses comparison narration for a single-branch fanout', () => {
    // A width-1 fanout is the common case (one review unit, one variant) and
    // is not a comparison: the operator already sees the step's own
    // narration, so "Comparing 1 option..." is broken English about an event
    // that is not happening. Single-branch fanout events stay in the stream
    // as bookkeeping but must not narrate.
    const progress = projectProgress('explore', [
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'explore' }),
      trace({
        sequence: 1,
        kind: 'fanout.started',
        step_id: 'synthesize-step',
        branch_ids: ['unit-1'],
      }),
      trace({
        sequence: 2,
        kind: 'fanout.joined',
        step_id: 'synthesize-step',
        policy: 'aggregate-only',
        aggregate_path: 'fanout/aggregate.json',
        branches_completed: 1,
        branches_failed: 0,
      }),
    ]);

    const started = progress.find((event) => event.type === 'fanout.started');
    expect(started).toBeDefined();
    expect(started?.presentation?.line_mode).toBe('suppress');
    expect(started?.display.importance).toBe('detail');
    expect(started?.display.text).not.toContain('Comparing');

    const joined = progress.find((event) => event.type === 'fanout.joined');
    expect(joined).toBeDefined();
    expect(joined?.presentation?.line_mode).toBe('suppress');
    expect(joined?.display.importance).toBe('detail');
    expect(joined?.display.text).not.toContain('comparing');
  });

  it('keeps comparison narration for a multi-branch fanout', () => {
    const progress = projectProgress('explore', [
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'explore' }),
      trace({
        sequence: 1,
        kind: 'fanout.started',
        step_id: 'synthesize-step',
        branch_ids: ['option-1', 'option-2', 'option-3'],
      }),
      trace({
        sequence: 2,
        kind: 'fanout.joined',
        step_id: 'synthesize-step',
        policy: 'pick-winner',
        selected_branch_id: 'option-2',
        aggregate_path: 'fanout/aggregate.json',
        branches_completed: 3,
        branches_failed: 0,
      }),
    ]);

    expect(progress.find((event) => event.type === 'fanout.started')?.presentation).toMatchObject({
      line_mode: 'replace_slot',
      status_text: 'Comparing 3 options...',
    });
    expect(progress.find((event) => event.type === 'fanout.joined')?.presentation).toMatchObject({
      line_mode: 'replace_slot',
      status_text: 'Finished comparing the options.',
    });
  });

  it('locks run.closed outcome derivations (completed and aborted)', () => {
    // Characterization: runOutcome/runReason fall back to 'aborted' and emit
    // distinct run.aborted vs run.completed progress events. Pin both branches
    // before centralizing the inline derivations.
    const completed = projectProgress('explore', [
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'explore' }),
      trace({ sequence: 1, kind: 'run.closed', outcome: 'complete' }),
    ]);
    expect(completed.find((event) => event.type === 'run.completed')).toMatchObject({
      type: 'run.completed',
      outcome: 'complete',
    });

    const aborted = projectProgress('explore', [
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'explore' }),
      trace({ sequence: 1, kind: 'run.closed', outcome: 'aborted', reason: 'boom' }),
    ]);
    const abortedEvent = aborted.find((event) => event.type === 'run.aborted');
    expect(abortedEvent).toMatchObject({ type: 'run.aborted', outcome: 'aborted', reason: 'boom' });
    expect(abortedEvent?.display.text).toBe('Circuit: Run aborted: boom');
  });

  it('reports a failed check honestly when the step routes to recovery', () => {
    // Honesty regression: a step whose check failed used to emit the same
    // detail/success/suppressed "Finished ..." copy as a passing step, so a
    // failed verification and its retry were invisible in the live stream.
    const progress = projectProgress('fix', [
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'fix' }),
      trace({ sequence: 1, kind: 'step.entered', step_id: 'fix-verify', attempt: 1 }),
      trace({
        sequence: 2,
        kind: 'check.evaluated',
        step_id: 'fix-verify',
        attempt: 1,
        check_kind: 'acceptance_criteria',
        outcome: 'fail',
        reason: 'npm test exited 1',
      }),
      trace({
        sequence: 3,
        kind: 'step.completed',
        step_id: 'fix-verify',
        attempt: 1,
        route_taken: 'retry',
      }),
    ]);

    const completed = progress.find((event) => event.type === 'step.completed');
    expect(completed?.display.text).toBe(
      'Circuit: Verify the fix did not pass on attempt 1; trying again.',
    );
    expect(completed?.display.importance).toBe('major');
    expect(completed?.display.tone).toBe('warning');
    expect(completed?.presentation).toMatchObject({
      line_mode: 'append',
      status_text: 'Verify the fix did not pass on attempt 1; trying again.',
    });
    expect(completed).toMatchObject({ route_taken: 'retry', failure_reason: 'npm test exited 1' });

    const lastTaskList = progress.filter((event) => event.type === 'task_list.updated').at(-1);
    expect(lastTaskList?.display.tone).toBe('warning');
    expect(lastTaskList?.tasks.find((task) => task.id === 'fix-verify')?.status).toBe('failed');
  });

  it('explains an exhaustion reroute instead of the generic recovery copy', () => {
    // When the retry budget behind a verify step is spent, the engine takes the
    // step's declared exhaustion route instead of aborting. The live stream
    // must say that plainly, not fall back to the generic "rerouting the run".
    const progress = projectProgress('fix', [
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'fix' }),
      trace({ sequence: 1, kind: 'step.entered', step_id: 'fix-verify', attempt: 2 }),
      trace({
        sequence: 2,
        kind: 'check.evaluated',
        step_id: 'fix-verify',
        attempt: 2,
        check_kind: 'acceptance_criteria',
        outcome: 'fail',
        reason: 'npm test exited 1',
      }),
      trace({
        sequence: 3,
        kind: 'step.exhaustion_rerouted',
        step_id: 'fix-verify',
        attempt: 2,
        from_route: 'retry',
        to_route: 'continue',
        reason: "route 'retry' for step 'fix-act' exhausted max_attempts=2",
      }),
      trace({
        sequence: 4,
        kind: 'step.completed',
        step_id: 'fix-verify',
        attempt: 2,
        route_taken: 'continue',
      }),
    ]);

    const completed = progress.find((event) => event.type === 'step.completed');
    expect(completed?.display.text).toBe(
      'Circuit: Verify the fix did not pass on attempt 2; the retry budget is spent, so the run moves on with the failing result recorded.',
    );
    expect(completed?.display.tone).toBe('warning');
    expect(completed).toMatchObject({
      route_taken: 'continue',
      failure_reason: 'npm test exited 1',
    });
    const lastTaskList = progress.filter((event) => event.type === 'task_list.updated').at(-1);
    expect(lastTaskList?.tasks.find((task) => task.id === 'fix-verify')?.status).toBe('failed');
  });

  it('keeps success copy for a later attempt that passes after a failed one', () => {
    const progress = projectProgress('fix', [
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'fix' }),
      trace({ sequence: 1, kind: 'step.entered', step_id: 'fix-verify', attempt: 1 }),
      trace({
        sequence: 2,
        kind: 'check.evaluated',
        step_id: 'fix-verify',
        attempt: 1,
        check_kind: 'acceptance_criteria',
        outcome: 'fail',
      }),
      trace({
        sequence: 3,
        kind: 'step.completed',
        step_id: 'fix-verify',
        attempt: 1,
        route_taken: 'retry',
      }),
      trace({ sequence: 4, kind: 'step.entered', step_id: 'fix-verify', attempt: 2 }),
      trace({
        sequence: 5,
        kind: 'check.evaluated',
        step_id: 'fix-verify',
        attempt: 2,
        check_kind: 'acceptance_criteria',
        outcome: 'pass',
      }),
      trace({
        sequence: 6,
        kind: 'step.completed',
        step_id: 'fix-verify',
        attempt: 2,
        route_taken: 'pass',
      }),
    ]);

    const completions = progress.filter((event) => event.type === 'step.completed');
    expect(completions.at(-1)?.display.text).toBe('Finished verifying the fix.');
    expect(completions.at(-1)?.display.tone).toBe('success');
    const lastTaskList = progress.filter((event) => event.type === 'task_list.updated').at(-1);
    expect(lastTaskList?.tasks.find((task) => task.id === 'fix-verify')?.status).toBe('completed');
  });

  it('keeps success copy when a passing check routes to a non-pass route', () => {
    // A decision step can legitimately route to 'stop' on a passing check
    // (for example, fix's no-repro decision). Only a failed check is a
    // failure; the route name alone is not.
    const progress = projectProgress('fix', [
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'fix' }),
      trace({ sequence: 1, kind: 'step.entered', step_id: 'fix-no-repro-decision', attempt: 1 }),
      trace({
        sequence: 2,
        kind: 'check.evaluated',
        step_id: 'fix-no-repro-decision',
        attempt: 1,
        check_kind: 'result_verdict',
        outcome: 'pass',
      }),
      trace({
        sequence: 3,
        kind: 'step.completed',
        step_id: 'fix-no-repro-decision',
        attempt: 1,
        route_taken: 'stop',
      }),
    ]);

    const completed = progress.find((event) => event.type === 'step.completed');
    expect(completed?.display.tone).toBe('success');
    expect(completed?.display.importance).toBe('detail');
  });

  it('reports non-complete run closes as warnings, not success', () => {
    // Honesty regression: a run that closed stopped/partial streamed
    // "Circuit: Finished Fix." with tone success as its final event.
    const stopped = projectProgress('fix', [
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'fix' }),
      trace({
        sequence: 1,
        kind: 'run.closed',
        outcome: 'stopped',
        reason: "primary result 'reports/fix-result.json' reported outcome 'partial'",
      }),
    ]);
    const stoppedEvent = stopped.find((event) => event.type === 'run.completed');
    expect(stoppedEvent?.display.text).toBe(
      "Circuit: Stopped Fix: primary result 'reports/fix-result.json' reported outcome 'partial'",
    );
    expect(stoppedEvent?.display.tone).toBe('warning');
    expect(stoppedEvent?.display.importance).toBe('major');
    expect(stoppedEvent?.presentation).toMatchObject({
      line_mode: 'append',
      status_text:
        "Stopped Fix: primary result 'reports/fix-result.json' reported outcome 'partial'",
    });
    expect(stoppedEvent).toMatchObject({
      outcome: 'stopped',
      reason: "primary result 'reports/fix-result.json' reported outcome 'partial'",
    });

    const handedOff = projectProgress('fix', [
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'fix' }),
      trace({ sequence: 1, kind: 'run.closed', outcome: 'handoff' }),
    ]);
    const handoffEvent = handedOff.find((event) => event.type === 'run.completed');
    expect(handoffEvent?.display.text).toBe('Circuit: Handed off Fix.');
    expect(handoffEvent?.display.tone).toBe('warning');

    const complete = projectProgress('fix', [
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'fix' }),
      trace({ sequence: 1, kind: 'run.closed', outcome: 'complete' }),
    ]);
    const completeEvent = complete.find((event) => event.type === 'run.completed');
    expect(completeEvent?.display.text).toBe('Circuit: Finished Fix.');
    expect(completeEvent?.display.tone).toBe('success');
  });

  it('keeps non-Explore relay started and completed copy stable', () => {
    const progress = projectProgress('review', [
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'review' }),
      trace({ sequence: 1, kind: 'step.entered', step_id: 'audit-step', attempt: 1 }),
      trace({
        sequence: 2,
        kind: 'relay.started',
        step_id: 'audit-step',
        role: 'reviewer',
        connector: { kind: 'builtin', name: 'claude-code' },
      }),
      trace({
        sequence: 3,
        kind: 'relay.completed',
        step_id: 'audit-step',
        role: 'reviewer',
        verdict: 'accept',
        duration_ms: 123,
      }),
    ]);

    expect(progress.find((event) => event.type === 'relay.started')?.display.text).toBe(
      'Circuit: Asking the reviewer to check the result...',
    );
    expect(progress.find((event) => event.type === 'relay.started')?.presentation).toMatchObject({
      line_mode: 'replace_slot',
      slot_id: 'audit-step:relay',
      status_text: 'Asking the reviewer to check the result...',
    });
    expect(progress.find((event) => event.type === 'relay.completed')?.display.text).toBe(
      'Circuit: Finished checking the result.',
    );
    expect(progress.find((event) => event.type === 'relay.completed')?.presentation).toMatchObject({
      line_mode: 'replace_slot',
      slot_id: 'audit-step:relay',
      status_text: 'Finished checking the result.',
    });
  });
});
