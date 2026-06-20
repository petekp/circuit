// Flow-shape composition (experimental, default-OFF): single-kind RELAY blocks
// must emit their execution descriptor.
//
// The composer omits the `execution` field for single-kind blocks because
// restating a block's bare default kind is rejected by the expander. A sub-run is
// the documented exception: its descriptor carries a required flow_ref/goal/depth
// that is NOT the bare default. A RELAY execution has the identical property — it
// carries a required `role` (researcher | implementer | reviewer) that is not the
// bare default — but the original condition only excepted sub-run. So a block
// whose ONLY kind is relay (clarify, goal-gate-review) had its execution dropped,
// and assemble then threw "expected one of researcher|implementer|reviewer".
//
// Multi-kind relay blocks (gather-context, diagnose, review declare
// ['relay','compose','fanout']) were unaffected: the composer already emits their
// execution via the multi-kind branch. Only the single-kind relay blocks lost the
// role. This locks that a single-kind relay block emits {kind:'relay', role}.

import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  type CompositionRoleSet,
  composeFlow,
  evaluateValidity,
} from '../../src/flows/composition/index.js';

// frame -> clarify(relay) -> diagnose(relay) -> plan -> act(relay) -> verify -> close.
// `clarify` declares executionKinds:['relay'] only, so it is the single-kind relay
// block that exercised the bug.
const CLARIFY_THEN_FIX: CompositionRoleSet = {
  id: 'clarify-then-fix',
  title: 'Clarify Then Fix',
  purpose: 'Clarify an ambiguous ask, then diagnose and fix it.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'frame', block: 'clarify', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'plan', block: 'plan', executionKind: 'compose' },
    { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
    { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

describe('flow-shape composition — single-kind relay execution', () => {
  const outcome = composeFlow(CLARIFY_THEN_FIX, { definitions: flowDefinitions });

  it('composes the clarify role set without a wall', () => {
    if (!outcome.ok) {
      throw new Error(`walls: ${outcome.walls.map((w) => `${w.block}: ${w.reason}`).join(' | ')}`);
    }
    expect(outcome.ok).toBe(true);
  });

  it('emits a relay execution descriptor carrying the role for the single-kind clarify block', () => {
    if (!outcome.ok) throw new Error('compose failed');
    const clarify = outcome.spec.items.find((it) => String(it.block) === 'clarify');
    if (!clarify) throw new Error('no clarify step in composed spec');
    const exec = clarify.execution as Record<string, unknown> | undefined;
    expect(exec?.kind).toBe('relay');
    expect(exec?.role).toBe('researcher');
  });

  it('is VALID by the real engine gates — assemble no longer throws on the dropped role', () => {
    if (!outcome.ok) throw new Error('compose failed');
    const validity = evaluateValidity(outcome.spec);
    if (!validity.valid) {
      throw new Error(
        `not valid: compiles=${validity.compiles} primary=${validity.boundPrimaryResult} error=${validity.error ?? 'none'} issues=${validity.catalogIssues.join(' ; ')}`,
      );
    }
    expect(validity.valid).toBe(true);
    expect(validity.boundPrimaryResult).toBe(true);
  });
});
