import { describe, expect, it } from 'vitest';

import { parseSmokeOptions, runLiveProbe } from '../../scripts/hosts/smoke/codex-mcp.js';

const enabled = process.env.CIRCUIT_MCP_LIVE_MISSING_NODE === '1' && process.platform === 'darwin';

describe.skipIf(!enabled)('Codex MCP real-loader missing Node diagnosis', () => {
  it('returns one clear remedy before a Circuit run can start', async () => {
    const remedy =
      'Install Node.js 22.18 or newer, ensure node is on PATH, restart Codex, and try again.';
    const result = await runLiveProbe(parseSmokeOptions(['--live', '--mode', 'packed']), {
      runtimePath: '/usr/bin:/bin',
    });

    expect(result).toMatchObject({
      status: 'fail',
      reason: remedy,
      failure: {
        class: 'dependency',
        code: 'node_missing',
        retryable: false,
        next_action: remedy,
      },
    });
  });
});
