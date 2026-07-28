// Refusals around per-branch item evidence.
//
// The happy path is proved end to end in tests/runner/fanout-branch-reads.test.ts.
// What matters here is what happens when the evidence is not there: a branch
// whose slice is missing or empty must stop the fanout, because a reviewer
// handed nothing reports nothing, and a clean report over nothing is the one
// outcome a split codebase review cannot survive.
import { describe, expect, it } from 'vitest';
import { expandFanoutBranches } from '../../src/runtime/fanout/branch-expansion.js';
import type { FanoutStep } from '../../src/runtime/manifest/executable-flow.js';
import type { RunFileStore } from '../../src/runtime/run-files/run-file-store.js';

const TEMPLATE = {
  branch_id: '$item.unit_id',
  execution: {
    kind: 'relay',
    role: 'reviewer',
    goal: 'Review $item.unit_id.',
    report_schema: 'sweep.unit-fix@v1',
    item_evidence_field: 'contents',
  },
};

function step(branches: unknown): FanoutStep {
  return { id: 'audit-step', kind: 'fanout', branches } as unknown as FanoutStep;
}

function fileStore(body: unknown): RunFileStore {
  return { readJson: async () => body } as unknown as RunFileStore;
}

function dynamic(): FanoutStep {
  return step({
    kind: 'dynamic',
    source_report: 'reports/units.json',
    items_path: 'units',
    template: TEMPLATE,
    max_branches: 8,
  });
}

describe('fanout item evidence', () => {
  it('lifts the named field off each item', async () => {
    const branches = await expandFanoutBranches(
      dynamic(),
      fileStore({ units: [{ unit_id: 'unit-1', contents: 'export const a = 1;' }] }),
    );

    expect(branches).toHaveLength(1);
    const branch = branches[0] as { item_evidence?: string };
    expect(branch.item_evidence).toBe('export const a = 1;');
  });

  it('refuses an item whose evidence field is empty', async () => {
    await expect(
      expandFanoutBranches(dynamic(), fileStore({ units: [{ unit_id: 'unit-1', contents: '' }] })),
    ).rejects.toThrow(/must be non-empty text/);
  });

  it('refuses an item that has no evidence field at all', async () => {
    await expect(
      expandFanoutBranches(dynamic(), fileStore({ units: [{ unit_id: 'unit-1' }] })),
    ).rejects.toThrow(/must be non-empty text/);
  });

  it('refuses item evidence on a static branch, which has no item', async () => {
    await expect(
      expandFanoutBranches(
        step({
          kind: 'static',
          branches: [{ branch_id: 'unit-1', execution: TEMPLATE.execution }],
        }),
        fileStore({}),
      ),
    ).rejects.toThrow(/needs a dynamic fanout/);
  });
});
