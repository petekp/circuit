// The flow-quality ratchet (offline flow lab).
//
// Mirrors tests/contracts/schematic-catalog-check.test.ts exactly: a
// BASELINE: Record<QualityClass, number> literal pins a ceiling per quality
// class, summed across the stable shipped-flow corpus, gated by
// toBeLessThanOrEqual so a number can only shrink. Lowering a ceiling is a
// reviewed edit to the literal. The completeness assertion forces a new quality
// class to be pinned (it cannot slip in unrationed).
//
// The scorer is collectFlowQualityIssues (experiments/flow-lab). Where the
// catalog check pins "every shipped flow fits the block catalog (0 issues)",
// this pins "the shipped flows' quality signals do not regress". Several classes
// have a non-zero baseline by construction: the shipped flows declare no
// skill_slots (work-step-without-skill-slots) and build/goal/pursue alias
// heavily (excess-contract-aliases). Those are the gaps the resolvers measure
// against, and the ratchet is what lets them be driven down and held down.
import { describe, expect, it } from 'vitest';

import {
  type QualityClass,
  buildSeedSpec,
  collapsedToSingleStep,
  collectFlowQualityIssues,
  emptyTally,
  scoreSchematic,
  scoreSpec,
  syntheticCorpus,
} from '../../experiments/flow-lab/index.js';
import type { FlowSchematic } from '../../src/schemas/flow-schematic.js';
import { schematicForFlow, shippedFlowSchematics } from '../helpers/in-memory-schematics.js';

// Per-class ceiling, summed across every shipped schematic. A class can only
// shrink. (Verify numbers below match the live tally the ratchet logs.)
const BASELINE: Record<QualityClass, number> = {
  // Guard signals — zero on well-formed shipped flows; fire only on a
  // hand-authored or mutated schematic that drops a stage without declaring it.
  'single-step-flow': 0,
  'undeclared-missing-act': 0,
  'undeclared-missing-verify': 0,
  'undeclared-missing-review': 0,
  'partial-spine-without-rationale': 0,
  // No shipped flow declares skill_slots: one issue per relay step (the gap the
  // equipment resolver measures against).
  'work-step-without-skill-slots': 19,
  'empty-evidence-requirements': 0,
  // build/goal/pursue alias heavily; one issue per alias beyond the 6 budget.
  'excess-contract-aliases': 28,
  // One shipped flow compiles without a derived runtime_surface.primary_result.
  'no-primary-result-binding': 1,
};

function shippedTally(): Record<QualityClass, number> {
  const tally = emptyTally();
  for (const schematic of shippedFlowSchematics()) {
    for (const issue of scoreSchematic(schematic).issues) tally[issue.key] += 1;
  }
  return tally;
}

describe('flow-quality ratchet (shipped schematics)', () => {
  it('covers exactly the quality classes — a new class must be added to the baseline', () => {
    expect(Object.keys(BASELINE).sort()).toEqual(emptyKeys());
  });

  it('never lets any quality class exceed its recorded ceiling', () => {
    const tally = shippedTally();
    const report: string[] = [];
    let total = 0;
    for (const key of Object.keys(BASELINE) as QualityClass[]) {
      total += tally[key];
      report.push(`${key}: ${tally[key]} (ceiling ${BASELINE[key]})`);
      expect(
        tally[key],
        `${key} gained quality issues above its recorded ceiling`,
      ).toBeLessThanOrEqual(BASELINE[key] ?? 0);
    }
    console.log(`\nflow quality issues: ${total} total\n${report.join('\n')}\n`);
  });
});

describe('the scorer is non-vacuous', () => {
  it('flags a single-step flow as under-decomposed', () => {
    const score = scoreSpec(collapsedToSingleStep(buildSeedSpec()));
    expect(score.score).not.toBeNull();
    if (score.score === null) return;
    expect(score.tally['single-step-flow']).toBeGreaterThanOrEqual(1);
  });

  it('a rich, well-formed flow is not flagged single-step', () => {
    for (const schematic of shippedFlowSchematics()) {
      expect(scoreSchematic(schematic).tally['single-step-flow']).toBe(0);
    }
  });

  it('fires the undeclared-missing guard when a stage is dropped without an omit', () => {
    // Mutate a parsed schematic the way the catalog test does: remove the review
    // step but leave stage_path_policy as-is (strict, no declared omit). A
    // silently-missing canonical stage must be caught.
    const build = schematicForFlow('build');
    const withoutReview: FlowSchematic = {
      ...build,
      items: build.items.filter((item) => item.stage !== 'review'),
    };
    const issues = collectFlowQualityIssues(withoutReview);
    expect(issues.some((issue) => issue.key === 'undeclared-missing-review')).toBe(true);
  });
});

describe('the harness tolerates failures as data (never throws)', () => {
  it('reports an assemble failure as data, not an exception', () => {
    const empty = syntheticCorpus().find((entry) => entry.name === 'empty');
    if (empty === undefined) throw new Error('empty variant missing from corpus');
    const score = scoreSpec(empty.spec);
    expect(score.assembled.ok).toBe(false);
    expect(score.score).toBeNull();
  });

  it('reports a compile failure as data and still scores the schematic', () => {
    const dropped = syntheticCorpus().find((entry) => entry.name === 'dropped-review');
    if (dropped === undefined) throw new Error('dropped-review variant missing from corpus');
    const score = scoreSpec(dropped.spec);
    expect(score.assembled.ok).toBe(true);
    if (score.score === null) throw new Error('expected dropped-review to assemble');
    expect(score.compiled.ok).toBe(false);
    expect(typeof score.score).toBe('number');
  });
});

function emptyKeys(): string[] {
  return Object.keys(emptyTally()).sort();
}
