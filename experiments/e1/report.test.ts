import { describe, expect, it } from 'vitest';
import { renderFixtureComparison } from './fixture.ts';
import { renderJson, renderMarkdown } from './report.ts';

const comparison = renderFixtureComparison('2026-06-13T00:00:00.000Z');

describe('renderMarkdown — the side-by-side', () => {
  const md = renderMarkdown(comparison);

  it('warns that the fixture mode spent no budget', () => {
    expect(md).toContain('Mode: fixture');
    expect(md).toContain('No model budget was spent');
  });

  it('flags the separated false-fix loudly', () => {
    expect(md).toContain('false-fix ⚠️');
  });

  it('shows the cost ratio with its basis', () => {
    // 1.85 / 0.42 ≈ 4.40
    expect(md).toContain('4.40x');
    expect(md).toContain('usd');
  });

  it('renders both flows and the verdict mismatch', () => {
    expect(md).toContain('`fix`');
    expect(md).toContain('`build`');
    expect(md).toContain('verdict match: **no**');
  });

  it('names the objective-check failure seam', () => {
    expect(md).toContain('objective_check');
    expect(md).toContain('wrap-negative');
  });
});

describe('renderJson', () => {
  it('round-trips the comparison as pretty JSON with a trailing newline', () => {
    const json = renderJson(comparison);
    expect(json.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(json);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.variants).toHaveLength(2);
    expect(parsed.delta.verdict_match).toBe(false);
  });
});
