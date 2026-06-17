// The offline flow lab — shared types.
//
// The flow lab generates assembled flows, inspects their shape, and scores
// their quality, entirely in memory and offline (no real codebase, no live
// host, no model spend). It is the measurement substrate the decision-layer
// resolvers are trialled through (see docs/ideas/next-phase-build-brief.md and
// docs/ideas/decision-layer-exploration.md).
//
// "Count = score": a flow's quality score is the number of QualityIssues the
// scorer finds. Lower is better. The closed QUALITY_CLASSES alphabet keeps
// scores comparable across flows the same way the closed block alphabet keeps
// runs comparable.

// The closed alphabet of quality signals the scorer can emit. Keeping this a
// small, fixed set (mirrored exactly by the ratchet baseline) is what makes a
// score on one flow commensurable with a score on another. A new class must be
// added here AND pinned in tests/contracts/flow-quality.test.ts, or the
// completeness assertion fails.
export const QUALITY_CLASSES = [
  // Structure signals (read off the schematic shape).
  'single-step-flow',
  'undeclared-missing-act',
  'undeclared-missing-verify',
  'undeclared-missing-review',
  'partial-spine-without-rationale',
  // Equipment + evidence signals (read off the steps).
  'work-step-without-skill-slots',
  'empty-evidence-requirements',
  // Seam-hygiene signals.
  'excess-contract-aliases',
  // Runtime-surface signals (read off the compiled flow).
  'no-primary-result-binding',
] as const;

export type QualityClass = (typeof QUALITY_CLASSES)[number];

// One quality deficiency. `key` is the class (used for the per-class ratchet);
// `message` is the human-readable diagnostic; `item_id` is present when the
// issue is attributable to a single schematic step. Mirrors the shape of
// FlowSchematicCatalogCompatibilityIssue so the two scorers read alike.
export interface QualityIssue {
  readonly key: QualityClass;
  readonly message: string;
  readonly item_id?: string;
}

// A per-class tally: every class present, count defaulting to zero. This is the
// shape the ratchet compares against its BASELINE record.
export type QualityTally = Record<QualityClass, number>;

export function emptyTally(): QualityTally {
  const tally = {} as QualityTally;
  for (const key of QUALITY_CLASSES) tally[key] = 0;
  return tally;
}

export function tallyByClass(issues: readonly QualityIssue[]): QualityTally {
  const tally = emptyTally();
  for (const issue of issues) tally[issue.key] += 1;
  return tally;
}
