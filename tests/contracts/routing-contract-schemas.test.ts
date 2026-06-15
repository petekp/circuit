// M8.1 (first-class composition): the routing-seam contracts carry real bodies.
//
// task.intake@v1, route.decision@v1, and flow.catalog@v1 were name-only
// identifiers before M8. These tests pin that (a) the contract-body resolver now
// resolves each to a signature — the seam is typed and visible to the M8.4 gate —
// and (b) each authored body actually validates the shape its block describes.
import { describe, expect, it } from 'vitest';

import { resolveFieldSignature } from '../../src/flows/contract-body-signature.js';
import { BUILTIN_ROUTING_CONTRACT_SCHEMAS } from '../../src/schemas/routing-contract-schemas.js';

const ROUTING_CONTRACTS = ['task.intake@v1', 'route.decision@v1', 'flow.catalog@v1'] as const;

describe('routing-seam contract bodies (M8.1)', () => {
  it('resolves a body signature for every routing-seam contract', () => {
    for (const contract of ROUTING_CONTRACTS) {
      expect(
        resolveFieldSignature(contract),
        `${contract} must resolve to a typed body, not a name-only identifier`,
      ).not.toBeNull();
    }
  });

  it('task.intake@v1 validates a normalized request and rejects a goalless one', () => {
    const schema = BUILTIN_ROUTING_CONTRACT_SCHEMAS['task.intake@v1'];
    expect(
      schema?.safeParse({ normalized_goal: 'ship the feature', constraints: [] }).success,
    ).toBe(true);
    expect(
      schema?.safeParse({
        normalized_goal: 'use build',
        requested_flow: 'build',
        constraints: ['no new deps'],
      }).success,
    ).toBe(true);
    expect(schema?.safeParse({ constraints: [] }).success).toBe(false);
  });

  it('route.decision@v1 validates a named flow and a stop, and rejects a missing reason', () => {
    const schema = BUILTIN_ROUTING_CONTRACT_SCHEMAS['route.decision@v1'];
    expect(
      schema?.safeParse({ selected_flow: 'fix', selection_reason: 'bug report' }).success,
    ).toBe(true);
    // A stop: no flow named, reason explains why.
    expect(
      schema?.safeParse({ selected_flow: null, selection_reason: 'goal too vague to route' })
        .success,
    ).toBe(true);
    expect(schema?.safeParse({ selected_flow: 'fix' }).success).toBe(false);
  });

  it('flow.catalog@v1 validates a non-empty flow list and rejects an empty one', () => {
    const schema = BUILTIN_ROUTING_CONTRACT_SCHEMAS['flow.catalog@v1'];
    expect(
      schema?.safeParse({
        flows: [{ id: 'build', title: 'Build', purpose: 'implement a change' }],
      }).success,
    ).toBe(true);
    expect(schema?.safeParse({ flows: [] }).success).toBe(false);
  });
});
