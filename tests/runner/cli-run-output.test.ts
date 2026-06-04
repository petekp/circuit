import { describe, expect, it } from 'vitest';

import { operatorSummaryOutputFields, routeOutputFields } from '../../src/cli/run-output.js';
import type { OperatorSummaryWriteResult } from '../../src/shared/operator-summary-writer.js';

describe('CLI run output domain values', () => {
  it('builds route fields without requiring process rendering', () => {
    expect(
      routeOutputFields({
        selectedFlow: 'fix',
        routedBy: 'explicit',
        routerReason: 'matched fix prefix',
        entryMode: 'lite',
        entryModeSource: 'explicit',
      }),
    ).toEqual({
      selected_flow: 'fix',
      routed_by: 'explicit',
      router_reason: 'matched fix prefix',
      entry_mode: 'lite',
      entry_mode_source: 'explicit',
    });
  });

  it('builds operator summary fields without requiring stdout writes', () => {
    const operatorSummary = {
      jsonPath: 'reports/operator-summary.json',
      markdownPath: 'reports/operator-summary.md',
      htmlPath: 'reports/operator-summary.html',
      summary: { status_text: 'Complete' },
    } as OperatorSummaryWriteResult;

    expect(operatorSummaryOutputFields({ operatorSummary })).toEqual({
      operator_summary_path: 'reports/operator-summary.json',
      operator_summary_markdown_path: 'reports/operator-summary.md',
      operator_summary_status_text: 'Complete',
      operator_summary_html_path: 'reports/operator-summary.html',
    });
  });
});
