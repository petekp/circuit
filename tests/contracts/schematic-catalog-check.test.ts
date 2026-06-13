// Stage 2 (first-class composition): the shared, report-only catalog-check seam
// plus the baseline ratchet that records where the eight shipped schematics
// stand against the strong route-aware validator.
//
// Why report-only, not a fail-closed compile gate: a probe across all eight
// schematics (the `records the current baseline` test below) found 128 issues
// across six of them. The block catalog is a coarse model — it reuses generic
// block ids (`goal`, `plan`) for structurally distinct schematic items — and
// only Fix and runtime-proof were authored to satisfy it. Flipping the check
// to fail-closed on the compile path would break the build for the other six.
// So Stage 2 lands the mechanism and the ratchet; the flip waits until the
// block model actually describes the built-ins. See
// docs/ideas/first-class-composition-sequence.md (Stage 2).
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { collectSchematicCatalogIssues } from '../../src/flows/schematic-catalog-check.js';
import { FlowSchematic } from '../../src/schemas/flow-schematic.js';

function loadSchematic(id: string): FlowSchematic {
  return FlowSchematic.parse(JSON.parse(readFileSync(`src/flows/${id}/schematic.json`, 'utf8')));
}

function shippedSchematicIds(): string[] {
  return readdirSync('src/flows', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        readFileSync(`src/flows/${name}/schematic.json`, 'utf8');
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

describe('collectSchematicCatalogIssues', () => {
  it('runs the route-aware validator against the in-process FLOW_BLOCK_CATALOG', () => {
    // Fix was authored block-first and is the exemplar; it must stay clean
    // through the shared seam, proving the seam binds the same catalog the
    // standalone validator uses.
    expect(collectSchematicCatalogIssues(loadSchematic('fix'))).toEqual([]);
  });

  it('surfaces a precise block+contract issue for a deliberately broken item', () => {
    // Mutate one Fix item so its declared output no longer matches the block
    // it names. A composed flow that wired an incompatible contract would fail
    // exactly this way; the seam must catch it.
    const schematic = loadSchematic('fix');
    const act = schematic.items.find((item) => (item.id as unknown as string) === 'fix-act');
    if (act === undefined) throw new Error('fix-act missing');
    act.stage = 'analyze';

    const issues = collectSchematicCatalogIssues(schematic);
    expect(issues).toContainEqual({
      item_id: 'fix-act',
      message: 'stage "analyze" is not compatible with block "act"; expected one of act',
    });
  });
});

describe('shipped schematics vs the block catalog (report-only ratchet)', () => {
  // The recorded baseline. These counts are NOT a target — they are a ceiling.
  // A schematic getting fixed lowers its count (good, never fails the test). A
  // schematic or a newly composed flow gaining a violation raises it (a
  // regression, fails the test). The two zeros are pinned exactly: Fix and
  // runtime-proof are the exemplars and must never regress.
  const BASELINE: Record<string, number> = {
    build: 3,
    explore: 7,
    fix: 0,
    goal: 113,
    prototype: 2,
    pursue: 1,
    review: 2,
    'runtime-proof': 0,
  };

  it('covers exactly the shipped schematics — a new flow must be added to the baseline', () => {
    expect(shippedSchematicIds()).toEqual(Object.keys(BASELINE).sort());
  });

  it('keeps the exemplars (Fix, runtime-proof) catalog-clean', () => {
    expect(collectSchematicCatalogIssues(loadSchematic('fix'))).toEqual([]);
    expect(collectSchematicCatalogIssues(loadSchematic('runtime-proof'))).toEqual([]);
  });

  it('never lets any schematic exceed its recorded issue ceiling', () => {
    const report: string[] = [];
    let total = 0;
    for (const id of shippedSchematicIds()) {
      const count = collectSchematicCatalogIssues(loadSchematic(id)).length;
      total += count;
      report.push(`${id}: ${count} (ceiling ${BASELINE[id]})`);
      expect(count, `${id} gained catalog issues above its recorded ceiling`).toBeLessThanOrEqual(
        BASELINE[id] ?? 0,
      );
    }
    // Surface the live tally so a reader sees the ratchet position at a glance.
    console.log(`\nschematic catalog issues: ${total} total\n${report.join('\n')}\n`);
  });
});
