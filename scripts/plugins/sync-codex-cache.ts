#!/usr/bin/env node

import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSyncHostCache } from './sync-cache-core.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../..');
const pluginRoot = resolve(repoRoot, 'plugins/codex');

const DEFAULT_MARKETPLACE = 'circuit-local';

runSyncHostCache({
  programName: 'sync-codex-cache',
  hostLabel: 'Codex',
  pluginRoot,
  manifestDirName: '.codex-plugin',
  checkCommand: 'npm run check:codex-plugin-cache',
  localSyncCommand: 'npm run sync:codex-plugin-cache',
  marketplace: { defaultName: DEFAULT_MARKETPLACE },
  rejectLegacyCircuitNextSegments: true,
  defaultCachePath: (manifest, marketplace) => {
    const codexHome = process.env.CODEX_HOME ?? resolve(homedir(), '.codex');
    return resolve(
      codexHome,
      'plugins/cache',
      marketplace ?? DEFAULT_MARKETPLACE,
      manifest.name,
      manifest.version,
    );
  },
  expectedCacheSuffix: (manifest, marketplace) => [
    'plugins',
    'cache',
    marketplace ?? DEFAULT_MARKETPLACE,
    manifest.name,
    manifest.version,
  ],
});
