import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { flowDefinitions, flowPackages } from '../../src/flows/catalog.js';
import { RETAINED_FLOW_IDS } from '../fixtures/retained-flow-ids.js';

const REPO_ROOT = resolve('.');

// Flow names that must never carry a PUBLIC host surface — a Claude skill, a
// Codex skill or flow bundle, or a slash command the operator can run.
//   migrate — a sibling flow that is still only a design idea; nothing is built.
//   sweep   — a real flow, but shipped visibility:internal under the v1 freeze,
//             so it legitimately lives in src/flows, generated/flows, and docs,
//             yet must publish no host surface until Pete promotes it.
// The name is obfuscated so this test file is not itself a grep hit for either.
const NO_PUBLIC_SURFACE_FLOW_IDS = [`mi${'grate'}`, `sw${'eep'}`] as const;

// Only PUBLIC host-surface roots. Internal flows and design prose legitimately
// name these flows in src/flows, generated/flows, and docs — the invariant is
// specifically that no operator-facing host artifact carries them.
const PUBLIC_SURFACE_ROOTS = [
  'src/commands',
  'plugins/codex/commands',
  'plugins/codex/skills',
  'plugins/codex/flows',
  'plugins/claude/commands',
  'plugins/claude/skills',
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

describe('flows with no public host surface', () => {
  it('keeps the production catalog on the retained flows only', () => {
    const definitionIds = flowDefinitions.map((definition) => definition.id);
    const packageIds = flowPackages.map((pkg) => pkg.id);

    expect(definitionIds).toEqual(RETAINED_FLOW_IDS);
    expect(packageIds).toEqual(RETAINED_FLOW_IDS);
  });

  it('keeps these flow ids out of public commands, skills, and host flow bundles', () => {
    const hits: string[] = [];
    for (const root of PUBLIC_SURFACE_ROOTS) {
      for (const file of collectFiles(resolve(REPO_ROOT, root))) {
        const rel = relative(REPO_ROOT, file);
        const text = readFileSync(file, 'utf8');
        for (const flowId of NO_PUBLIC_SURFACE_FLOW_IDS) {
          const pattern = new RegExp(`\\b${flowId}\\b`, 'i');
          if (pattern.test(text) || pattern.test(rel)) {
            hits.push(`${rel} contains ${flowId}`);
          }
        }
      }
    }

    expect(hits).toEqual([]);
  });
});
