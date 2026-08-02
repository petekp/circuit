// A step that reads a report which is not there should say which report and
// who owed it, not print an errno and an absolute path.
import { describe, expect, it } from 'vitest';

import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import { missingInputReason } from '../../src/runtime/run/missing-input.js';

const RUN_DIR = '/Users/someone/.circuit/runs/20260802-101500-prototype';

function flowWith(
  steps: readonly { readonly id: string; readonly writes?: Record<string, string> }[],
): ExecutableFlow {
  return {
    steps: steps.map((step) => ({
      id: step.id,
      ...(step.writes === undefined
        ? {}
        : {
            writes: Object.fromEntries(
              Object.entries(step.writes).map(([name, path]) => [name, { path }]),
            ),
          }),
    })),
  } as unknown as ExecutableFlow;
}

function enoent(path: string): string {
  return `ENOENT: no such file or directory, open '${path}'`;
}

describe('missingInputReason', () => {
  const flow = flowWith([
    { id: 'frame-step', writes: { report: 'reports/prototype/brief.json' } },
    { id: 'plan-step', writes: { report: 'reports/prototype/plan.json' } },
    { id: 'act-step' },
  ]);

  it('names the report and the step that was supposed to write it', () => {
    const reason = missingInputReason({
      flow,
      runDir: RUN_DIR,
      stepId: 'plan-step',
      message: enoent(`${RUN_DIR}/reports/prototype/brief.json`),
    });
    expect(reason).toBe(
      "step 'plan-step' needs 'reports/prototype/brief.json', which is not in the run folder. 'frame-step' writes that report; it did not run, or it ran without writing.",
    );
  });

  it('drops the absolute path so the sentence is about the run, not the machine', () => {
    const reason = missingInputReason({
      flow,
      runDir: RUN_DIR,
      stepId: 'plan-step',
      message: enoent(`${RUN_DIR}/reports/prototype/brief.json`),
    });
    expect(reason).not.toContain(RUN_DIR);
    expect(reason).not.toContain('ENOENT');
  });

  it('calls out a flow that reads a report no step writes', () => {
    const reason = missingInputReason({
      flow,
      runDir: RUN_DIR,
      stepId: 'act-step',
      message: enoent(`${RUN_DIR}/reports/prototype/nobody-writes-this.json`),
    });
    expect(reason).toContain('No step in this flow writes that report');
  });

  it('says so when the step failed writing its own report', () => {
    const reason = missingInputReason({
      flow,
      runDir: RUN_DIR,
      stepId: 'frame-step',
      message: enoent(`${RUN_DIR}/reports/prototype/brief.json`),
    });
    expect(reason).toContain('This step writes that report itself');
  });

  it('keeps a path it cannot place under the run folder', () => {
    const reason = missingInputReason({
      flow,
      runDir: RUN_DIR,
      stepId: 'act-step',
      message: enoent('/etc/somewhere/else.json'),
    });
    expect(reason).toContain('/etc/somewhere/else.json');
  });

  // Half-translating is worse than not translating: an unrecognized message is
  // usually already the clearest account anyone has of what went wrong.
  it('leaves anything that is not a missing file alone', () => {
    for (const message of [
      'connector claude-code is signed out',
      "EACCES: permission denied, open '/x/y.json'",
      'Unexpected token } in JSON at position 12',
      '',
    ]) {
      expect(
        missingInputReason({ flow, runDir: RUN_DIR, stepId: 'act-step', message }),
      ).toBeUndefined();
    }
  });
});
