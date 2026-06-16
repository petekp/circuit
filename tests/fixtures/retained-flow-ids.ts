// Pinned roster of every flow id the production catalog ships, in catalog
// order. This is a hand-maintained literal on purpose: the tests below assert
// that the live catalog (src/flows/catalog.ts) equals this list, so adding or
// removing a flow fails until an author updates this one place. Do NOT derive
// it from the catalog — that would make those assertions tautological and
// silence the gate.
//
// Consumers (keep this list current when you add a consumer):
//   - tests/runner/flow-facts.test.ts
//   - tests/contracts/retired-flow-surface.test.ts
export const RETAINED_FLOW_IDS = [
  'review',
  'fix',
  'pursue',
  'runtime-proof',
  'prototype',
  'build',
  'explore',
  'goal',
  'explainer',
] as const;
