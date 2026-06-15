import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OperatorSummary } from '../../src/schemas/operator-summary.js';
import { ProcessEvidenceProjection } from '../../src/schemas/process-evidence.js';
import { RunResult } from '../../src/schemas/result.js';
import { TraceEntry } from '../../src/schemas/trace-entry.js';
import { FIXTURES_ROOT } from './fixture.ts';

// The fixtures are only worth trusting if they are the shapes the engine
// actually emits. Validating each artifact against the real runtime Zod schemas
// keeps the fixtures from drifting into convenient fiction the extractor is
// secretly tuned to. If a schema tightens, this test fails until the fixture is
// brought back in line — exactly the coupling we want.

const FIXTURE_DIRS = ['holistic-pass', 'separated-falsefix'] as const;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe.each(FIXTURE_DIRS)('fixture %s validates against the real schemas', (dir) => {
  const root = join(FIXTURES_ROOT, dir);

  it('reports/result.json is a valid RunResult', () => {
    const parsed = RunResult.safeParse(readJson(join(root, 'reports/result.json')));
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
  });

  it('reports/operator-summary.json is a valid OperatorSummary', () => {
    const parsed = OperatorSummary.safeParse(readJson(join(root, 'reports/operator-summary.json')));
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
  });

  it('reports/process-evidence.json is a valid ProcessEvidenceProjection', () => {
    const parsed = ProcessEvidenceProjection.safeParse(
      readJson(join(root, 'reports/process-evidence.json')),
    );
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
  });

  it('every trace.ndjson line is a valid TraceEntry', () => {
    const lines = readFileSync(join(root, 'trace.ndjson'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const [index, line] of lines.entries()) {
      const parsed = TraceEntry.safeParse(JSON.parse(line));
      expect(parsed.success, `line ${index}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });
});
