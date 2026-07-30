import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { anchorPackagedServerToDurableCwd } from '../../src/hosts/codex-mcp/entrypoint.js';

// Codex 0.146 reinstalls the plugin cache after spawning the MCP server,
// deleting the directory the server was launched from. The anchor must move
// the process into the durable Codex home even when the launch directory is
// already gone.
describe('packaged server durable working-directory anchor', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('moves the server out of a deleted launch directory into the Codex home', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'circuit-anchor-home-'));
    const doomed = mkdtempSync(join(tmpdir(), 'circuit-anchor-doomed-'));
    process.chdir(doomed);
    rmSync(doomed, { recursive: true, force: true });
    try {
      await expect(anchorPackagedServerToDurableCwd({ CODEX_HOME: codexHome })).resolves.toBe(
        realpathSync(codexHome),
      );
      expect(process.cwd()).toBe(realpathSync(codexHome));
    } finally {
      process.chdir(originalCwd);
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it('reports a missing Codex home instead of anchoring nowhere', async () => {
    await expect(
      anchorPackagedServerToDurableCwd({
        CODEX_HOME: join(tmpdir(), 'circuit-anchor-does-not-exist'),
      }),
    ).rejects.toThrow(/existing directory/i);
  });
});
