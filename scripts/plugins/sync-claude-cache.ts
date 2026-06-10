#!/usr/bin/env node

import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSyncHostCache } from './sync-cache-core.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../..');
const pluginRoot = resolve(repoRoot, 'plugins/claude');

runSyncHostCache({
  programName: 'sync-claude-cache',
  hostLabel: 'Claude',
  pluginRoot,
  manifestDirName: '.claude-plugin',
  checkCommand: 'npm run check:claude-plugin-cache',
  localSyncCommand: 'npm run sync:claude-plugin-cache',
  defaultCachePath: (manifest) => {
    const home = process.env.HOME ?? homedir();
    return resolve(home, '.claude/plugins/cache', manifest.name, manifest.name, manifest.version);
  },
  expectedCacheSuffix: (manifest) => [
    'plugins',
    'cache',
    manifest.name,
    manifest.name,
    manifest.version,
  ],
});
