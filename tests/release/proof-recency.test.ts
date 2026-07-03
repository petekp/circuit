import { describe, expect, it } from 'vitest';
import { compareProofRecency } from '../../scripts/release/proof-recency.ts';

// compareProofRecency is the drift half of the proof stub-freshness guard: given
// a fresh run's semantic signals and the committed proof's, it returns one
// operator-facing message per drift. These pin the exact conditions that must
// go red so the guard cannot quietly stop biting.
describe('compareProofRecency', () => {
  const base = {
    slug: 'explore-standard',
    freshOutcome: 'complete',
    committedOutcome: 'complete',
    freshReportNames: ['brief.json', 'analysis.json', 'relay'],
    committedReportNames: ['brief.json', 'analysis.json', 'relay'],
  };

  it('is silent when outcome and report set both match', () => {
    expect(compareProofRecency(base)).toEqual([]);
  });

  it('ignores report-name ordering (compares as a set)', () => {
    expect(
      compareProofRecency({
        ...base,
        freshReportNames: ['relay', 'analysis.json', 'brief.json'],
      }),
    ).toEqual([]);
  });

  it('flags terminal outcome drift naming the scenario and both values', () => {
    const failures = compareProofRecency({ ...base, committedOutcome: 'aborted' });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("scenario 'explore-standard'");
    expect(failures[0]).toContain('outcome drifted');
    expect(failures[0]).toContain("now ends 'complete'");
    expect(failures[0]).toContain("claims 'aborted'");
    expect(failures[0]).toContain('--scenario explore-standard');
  });

  it('reports the fresh outcome as unknown when the run produced no outcome', () => {
    const failures = compareProofRecency({
      ...base,
      freshOutcome: undefined,
      committedOutcome: 'complete',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("now ends 'unknown'");
    expect(failures[0]).toContain("claims 'complete'");
  });

  it('flags a missing committed outcome rather than silently passing', () => {
    const failures = compareProofRecency({ ...base, committedOutcome: undefined });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('no committed outcome');
    expect(failures[0]).toContain('result.json');
  });

  it('flags a report file the fresh run added but the committed proof lacks', () => {
    const failures = compareProofRecency({
      ...base,
      freshReportNames: [...base.freshReportNames, 'surprise.json'],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('report set drifted');
    expect(failures[0]).toContain('now writes surprise.json');
  });

  it('flags a report file the committed proof has but the fresh run no longer writes', () => {
    const failures = compareProofRecency({
      ...base,
      committedReportNames: [...base.committedReportNames, 'compose.json'],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('report set drifted');
    expect(failures[0]).toContain('no longer writes compose.json');
  });

  it('names both an added and a removed report file in one message', () => {
    const failures = compareProofRecency({
      ...base,
      freshReportNames: ['brief.json', 'analysis.json', 'relay', 'added.json'],
      committedReportNames: ['brief.json', 'analysis.json', 'relay', 'dropped.json'],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('now writes added.json');
    expect(failures[0]).toContain('no longer writes dropped.json');
  });

  it('returns a message per drift when outcome and report set both drift', () => {
    const failures = compareProofRecency({
      ...base,
      committedOutcome: 'checkpoint_waiting',
      committedReportNames: ['brief.json'],
    });
    expect(failures).toHaveLength(2);
    expect(failures.some((f) => f.includes('outcome drifted'))).toBe(true);
    expect(failures.some((f) => f.includes('report set drifted'))).toBe(true);
  });
});
