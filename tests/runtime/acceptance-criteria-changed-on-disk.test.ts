import { describe, expect, it } from 'vitest';
import { buildBlockItems } from '../../src/flows/build/assembly-spec.js';
import { fixBlockItems } from '../../src/flows/fix/assembly-spec.js';
import { evaluateAcceptanceCriteria } from '../../src/runtime/acceptance-criteria.js';
import {
  type AcceptanceCriteria,
  AcceptanceCriteriaReportFieldCriterion,
  AcceptanceCriteriaReportFieldPredicate,
} from '../../src/schemas/acceptance-criteria.js';

// The `changed_on_disk` predicate cross-checks a worker's self-reported
// `changed_files` against the real working-tree diff at the relay accept gate.
// A worker that claims a file it never touched (an overclaim) must fail the
// gate — the exact seam the equipment-scope boundary proof surfaced, where a
// read-only worker listed a file it could not have edited and the shallow
// `present` predicate waved it through.

const PROJECT_ROOT = '/tmp/does-not-matter-stub-injected';

function criteriaWith(changedOnDisk: boolean, claimedPath = 'changed_files'): AcceptanceCriteria {
  return {
    checks: [
      {
        kind: 'report_field',
        id: 'changed-files-on-disk',
        path: [claimedPath],
        predicate: changedOnDisk ? 'changed_on_disk' : 'present',
      },
    ],
    on_failure: { mode: 'retry-with-feedback' },
  } as AcceptanceCriteria;
}

describe('acceptance criteria — changed_on_disk predicate', () => {
  it('passes when every claimed path actually changed in the working tree', async () => {
    const result = await evaluateAcceptanceCriteria({
      stepId: 'fix-act',
      criteria: criteriaWith(true),
      resultBody: JSON.stringify({ changed_files: ['src/foo.ts', 'src/bar.ts'] }),
      projectRoot: PROJECT_ROOT,
      captureChangedPaths: () => new Set(['src/foo.ts', 'src/bar.ts', 'reports/fix/change.json']),
    });
    expect(result.kind).toBe('pass');
  });

  it('FAILS when a claimed path shows no change on disk (overclaim)', async () => {
    const result = await evaluateAcceptanceCriteria({
      stepId: 'fix-act',
      criteria: criteriaWith(true),
      // Worker claims it changed src/buggy.ts, but the working tree is clean.
      resultBody: JSON.stringify({ changed_files: ['src/buggy.ts'] }),
      projectRoot: PROJECT_ROOT,
      captureChangedPaths: () => new Set<string>(),
    });
    expect(result.kind).toBe('fail');
    if (result.kind !== 'fail') return;
    // The reason names the offending path so retry feedback is actionable.
    expect(result.reason).toContain('src/buggy.ts');
    expect(result.on_failure).toEqual({ mode: 'retry-with-feedback' });
    expect(result.feedback.criterion_id).toBe('changed-files-on-disk');
    expect(result.feedback.reason).toContain('src/buggy.ts');
  });

  it('ignores extra dirt — a real change the worker did not claim never fails the gate', async () => {
    const result = await evaluateAcceptanceCriteria({
      stepId: 'fix-act',
      criteria: criteriaWith(true),
      resultBody: JSON.stringify({ changed_files: ['src/foo.ts'] }),
      projectRoot: PROJECT_ROOT,
      // Tree also has an unclaimed dirty file; claimed ⊆ dirty still holds.
      captureChangedPaths: () => new Set(['src/foo.ts', 'src/unrelated.ts']),
    });
    expect(result.kind).toBe('pass');
  });

  it('is inapplicable (passes) when projectRoot is absent — no tree to observe', async () => {
    // The predicate asserts a property of an observable tree. With no project
    // root there is nothing to observe, so the claim is vacuously consistent.
    // A worker cannot induce this; real runs always carry a project root.
    const result = await evaluateAcceptanceCriteria({
      stepId: 'fix-act',
      criteria: criteriaWith(true),
      resultBody: JSON.stringify({ changed_files: ['src/foo.ts'] }),
      captureChangedPaths: () => new Set(['src/foo.ts']),
    });
    expect(result.kind).toBe('pass');
  });

  it('is inapplicable (passes) when the working-tree capture throws — tree not observable', async () => {
    // git error / not a repository is environmental, not a caught lie. Failing
    // here would only emit nonsense retry feedback the worker cannot act on, and
    // would abort runs in off-git environments where every other touched-files
    // check is already inert.
    const result = await evaluateAcceptanceCriteria({
      stepId: 'fix-act',
      criteria: criteriaWith(true),
      resultBody: JSON.stringify({ changed_files: ['src/foo.ts'] }),
      projectRoot: PROJECT_ROOT,
      captureChangedPaths: () => {
        throw new Error('not a git repository');
      },
    });
    expect(result.kind).toBe('pass');
  });

  it('treats an empty claim list as a vacuous pass (absence is present/non_empty job)', async () => {
    const result = await evaluateAcceptanceCriteria({
      stepId: 'build-act',
      criteria: criteriaWith(true),
      resultBody: JSON.stringify({ changed_files: [] }),
      projectRoot: PROJECT_ROOT,
      captureChangedPaths: () => new Set(['src/foo.ts']),
    });
    expect(result.kind).toBe('pass');
  });
});

describe('acceptance criteria schema — changed_on_disk is a legal predicate', () => {
  it('accepts changed_on_disk in the predicate enum', () => {
    expect(AcceptanceCriteriaReportFieldPredicate.parse('changed_on_disk')).toBe('changed_on_disk');
  });

  it('accepts a report_field criterion using changed_on_disk', () => {
    const parsed = AcceptanceCriteriaReportFieldCriterion.parse({
      kind: 'report_field',
      id: 'changed-files-on-disk',
      path: ['changed_files'],
      predicate: 'changed_on_disk',
    });
    expect(parsed.predicate).toBe('changed_on_disk');
  });
});

describe('fix-act and build-act changed_on_disk wiring', () => {
  function actStep(items: typeof fixBlockItems): { acceptanceCriteria?: AcceptanceCriteria } {
    const act = items.find((item) => item.block === 'act');
    if (act === undefined) throw new Error('expected an act step');
    return act as { acceptanceCriteria?: AcceptanceCriteria };
  }

  function actStepChecks(
    items: typeof fixBlockItems,
  ): readonly { id?: string; predicate?: string }[] {
    const criteria = actStep(items).acceptanceCriteria;
    if (criteria === undefined) throw new Error('expected act step to carry acceptance criteria');
    return criteria.checks.map((c) => ({
      id: c.id,
      ...(c.kind === 'report_field' ? { predicate: c.predicate } : {}),
    }));
  }

  // Fix dropped the instantaneous disk gate: it false-rejects a worker that
  // honestly restores a file to its checked-in state within the same attempt,
  // and the dedicated change-set step already polices overclaims against the
  // run baseline with cross-attempt awareness. Two gates charging the same
  // shared retry budget for one root cause aborted live runs.
  it('fix-act does not gate changed_files on instantaneous disk state', () => {
    const checks = actStepChecks(fixBlockItems);
    expect(checks).not.toContainEqual({
      id: 'changed-files-on-disk',
      predicate: 'changed_on_disk',
    });
    expect(checks).toContainEqual({ id: 'changed-files-present', predicate: 'present' });
    expect(checks).toContainEqual({ id: 'evidence-non-empty', predicate: 'non_empty' });
  });

  it('fix-act accepts an honest report whose claimed file was restored to HEAD', async () => {
    const criteria = actStep(fixBlockItems).acceptanceCriteria;
    if (criteria === undefined) throw new Error('expected fix-act acceptance criteria');
    const result = await evaluateAcceptanceCriteria({
      stepId: 'fix-act',
      criteria,
      // The worker edited src/paginate.mjs, concluded the edit was wrong, and
      // restored it byte-for-byte — then reported what it touched. git status
      // shows the path clean, so the old disk gate branded this honest report
      // an overclaim and burned a retry.
      resultBody: JSON.stringify({
        changed_files: ['src/paginate.mjs'],
        evidence: ['restored src/paginate.mjs to the checked-in revision after a wrong turn'],
      }),
      projectRoot: PROJECT_ROOT,
      captureChangedPaths: () => new Set(['reports/fix/change.json']),
    });
    expect(result.kind).toBe('pass');
  });

  it('build-act carries a changed_on_disk check on changed_files', () => {
    const checks = actStepChecks(buildBlockItems);
    expect(checks).toContainEqual({ id: 'changed-files-on-disk', predicate: 'changed_on_disk' });
  });
});
