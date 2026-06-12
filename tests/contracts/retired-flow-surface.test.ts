import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { flowDefinitions, flowPackages } from '../../src/flows/catalog.js';
import { RETAINED_FLOW_IDS } from '../fixtures/retained-flow-ids.js';

const REPO_ROOT = resolve('.');
const RETIRED_FLOW_IDS = [`mi${'grate'}`, `sw${'eep'}`] as const;
const SURFACE_ROOTS = [
  'src/flows',
  'src/commands',
  'plugins/codex/commands',
  'plugins/codex/skills',
  'plugins/codex/flows',
  'plugins/claude/commands',
  'plugins/claude/skills',
  'generated/flows',
  'docs/flows',
  'docs/architecture',
];

function collectFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const stat = statSync(root);
  if (stat.isFile()) return [root];
  return readdirSync(root).flatMap((name) => {
    const child = join(root, name);
    const childStat = statSync(child);
    if (childStat.isDirectory()) return collectFiles(child);
    return childStat.isFile() ? [child] : [];
  });
}

describe('retired public flow surface', () => {
  it('keeps the production catalog on the retained flows only', () => {
    const definitionIds = flowDefinitions.map((definition) => definition.id);
    const packageIds = flowPackages.map((pkg) => pkg.id);

    expect(definitionIds).toEqual(RETAINED_FLOW_IDS);
    expect(packageIds).toEqual(RETAINED_FLOW_IDS);
  });

  it('keeps retired flow ids out of public commands, skills, manifests, and docs', () => {
    const hits: string[] = [];
    for (const root of SURFACE_ROOTS) {
      for (const file of collectFiles(resolve(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        const text = readFileSync(file, 'utf8');
        for (const retired of RETIRED_FLOW_IDS) {
          const pattern = new RegExp(`\\b${retired}\\b`, 'i');
          if (pattern.test(text) || pattern.test(rel)) {
            hits.push(`${rel} contains ${retired}`);
          }
        }
      }
    }

    expect(hits).toEqual([]);
  });
});
