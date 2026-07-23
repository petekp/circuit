import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseSmokeOptions, runLiveProbe } from '../../scripts/hosts/smoke/codex-mcp.js';

const enabled = process.env.CIRCUIT_MCP_LIVE_OLD_NODE === '1' && process.platform === 'darwin';

describe.skipIf(!enabled)('Codex MCP real-loader old Node diagnosis', () => {
  it('returns one clear remedy before the old Node starts the MCP runtime', async () => {
    const oldNodeBin = process.env.CIRCUIT_MCP_OLD_NODE_BIN;
    expect(
      oldNodeBin,
      'CIRCUIT_MCP_OLD_NODE_BIN must name the pinned Node 22.17.1 bin',
    ).toBeTruthy();
    const oldNode = join(oldNodeBin ?? '', 'node');
    expect(execFileSync(oldNode, ['--version'], { encoding: 'utf8' }).trim()).toBe('v22.17.1');
    const [testMajor, testMinor] = process.versions.node.split('.').map(Number);
    expect(
      (testMajor ?? 0) > 22 || ((testMajor ?? 0) === 22 && (testMinor ?? 0) >= 18),
      `Vitest must run on Node 22.18 or newer, got ${process.versions.node}`,
    ).toBe(true);

    const result = await runLiveProbe(parseSmokeOptions(['--live', '--mode', 'packed']), {
      runtimePath: `${oldNodeBin}:/usr/bin:/bin`,
    });

    expect(result).toMatchObject({
      status: 'fail',
      failure: {
        class: 'dependency',
        code: 'node_too_old',
        retryable: false,
        next_action:
          'Install Node.js 22.18 or newer, ensure node is on PATH, restart Codex, and try again.',
      },
    });
    expect(result.reason).toContain('Current Node.js is 22.17.1.');
    expect(result.reason).toContain(
      'Install Node.js 22.18 or newer, ensure node is on PATH, restart Codex, and try again.',
    );
  });
});
