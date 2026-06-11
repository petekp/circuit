import { describe, expect, it } from 'vitest';

import type { OperatorSummaryWriteResult } from '../../src/app/operator-summary/writer.js';
import { operatorSummaryOutputFields, routeOutputFields } from '../../src/cli/run-output.js';

describe('CLI run output domain values', () => {
  it('builds route fields without requiring process rendering', () => {
    expect(
      routeOutputFields({
        selectedFlow: 'fix',
        routedBy: 'explicit',
        routerReason: 'matched fix prefix',
        entryMode: 'low',
        entryModeSource: 'explicit',
      }),
    ).toEqual({
      selected_flow: 'fix',
      routed_by: 'explicit',
      router_reason: 'matched fix prefix',
      entry_mode: 'low',
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
