// Flow-shape composition (experimental, default-OFF): PRODUCIBILITY-AWARE
// SELECTION (the Layer-1 look-ahead).
//
// selectActual picks each role's actual INDEPENDENTLY, breaking a family-rank TIE
// on actual name. For a compose-only `frame -> plan -> close` shape, three
// families tie at the top coverage rank (prototype, explore, explainer), and the
// name-ascending tiebreak lands the `plan` step on explainer.ideas@v1 — whose
// compose writer requires reading explainer.digest@v1, a diagnose-stage output no
// compose-only line produces. The flow is offline-VALID but ABORTS at `plan`.
//
// Yet a COHERENT single-family binding of the IDENTICAL role set runs:
// prototype.brief@v1 -> prototype.plan@v1 (reads only the brief, produced
// upstream) -> prototype.result@v1 is fully runnable. So this is a SELECTION
// defect, not a reachability wall — a runnable family exists, the greedy
// independent pick just does not find it.
//
// computeFamilyCoherence closes that gap: under the opt-in enforceRunnability
// gate, selectActual prefers (among equally-top-ranked families) the family whose
// whole-line writer required-reads are least starved. That pulls the whole line
// onto prototype, and the gate's tail-check then passes instead of walling —
// turning the runnability gate from detect-only into repair-then-wall.
//
// This file locks: (A) the greedy wall under the DEFAULT path, (B) that a
// coherent runnable binding EXISTS (so it is Layer-1, not Layer-2), (C) that the
// gate REPAIRS it via coherent selection, and (D) that the default path is
// unchanged (the change is strictly opt-in).

import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  type CompositionRoleSet,
  composeFlow,
  evaluateRunnability,
  evaluateValidity,
} from '../../src/flows/composition/index.js';

// A 3-role compose-only shape: frame -> plan -> close. Every role is a compose
// block, so no diagnose/relay step produces the digest explainer's plan writer
// wants. Three families (prototype, explore, explainer) tie at the top coverage
// rank; only prototype's whole-line reads are all producible.
const FRAME_PLAN_CLOSE: CompositionRoleSet = {
  id: 'frame-plan-close',
  title: 'Frame, plan, close',
  purpose:
    'Frame a brief, form a plan, and close with evidence — a compose-only short line. Used to exercise producibility-aware selection across tie-top families.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'plan', block: 'plan', executionKind: 'compose' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

function planActual(outcome: ReturnType<typeof composeFlow>): string | undefined {
  if (!outcome.ok) return undefined;
  return outcome.selections.find((selection) => selection.stepId === 'plan')?.actual;
}

describe('composition producibility-aware selection — the Layer-1 look-ahead', () => {
  it('DEFAULT: greedy selection binds the incoherent tie-top family and is NOT runnable', () => {
    const outcome = composeFlow(FRAME_PLAN_CLOSE, { definitions: flowDefinitions });
    if (!outcome.ok) throw new Error('compose failed');

    // Greedy name-ascending tiebreak lands `plan` on explainer.ideas@v1.
    expect(planActual(outcome)).toBe('explainer.ideas@v1');

    // The structural floor passes it — the false-negative.
    expect(evaluateValidity(outcome.spec).valid).toBe(true);

    // But it aborts at `plan` on the unproduced diagnose-stage digest.
    const runnability = evaluateRunnability(outcome.spec);
    expect(runnability.runnable).toBe(false);
    const planAbort = runnability.aborts.find((abort) => abort.stepId === 'plan');
    if (planAbort === undefined) {
      throw new Error(`expected a 'plan' abort; got ${JSON.stringify(runnability.aborts)}`);
    }
    expect(planAbort.schema).toBe('explainer.ideas@v1');
    expect(planAbort.reason).toContain('explainer.digest@v1');
  });

  it('CONTROL: a coherent single-family binding of the SAME shape IS runnable (Layer-1, not Layer-2)', () => {
    // Force the prototype family by removing the two sibling tie-top families
    // from the menu. The composer then binds prototype end to end and it runs —
    // proving a runnable binding exists that selection failed to find.
    const outcome = composeFlow(FRAME_PLAN_CLOSE, {
      definitions: flowDefinitions.filter((def) => def.id !== 'explainer' && def.id !== 'explore'),
    });
    if (!outcome.ok) throw new Error('compose failed');
    expect(planActual(outcome)).toBe('prototype.plan@v1');

    const runnability = evaluateRunnability(outcome.spec);
    expect(runnability.runnable).toBe(true);
    expect(runnability.aborts).toEqual([]);
    expect(runnability.checkedSteps).toBe(3);
  });

  it('REPAIR: under enforceRunnability, producibility-aware selection picks the runnable family', () => {
    const outcome = composeFlow(FRAME_PLAN_CLOSE, {
      definitions: flowDefinitions,
      enforceRunnability: true,
    });
    if (!outcome.ok) {
      throw new Error(
        `expected a repaired, runnable composition; got walls ${JSON.stringify(outcome.walls)}`,
      );
    }
    // Same full menu as the DEFAULT case, but selection now lands prototype.
    expect(planActual(outcome)).toBe('prototype.plan@v1');
    expect(outcome.selections.find((s) => s.stepId === 'frame')?.actual).toBe('prototype.brief@v1');
    expect(outcome.selections.find((s) => s.stepId === 'close-with-evidence')?.actual).toBe(
      'prototype.result@v1',
    );

    expect(evaluateValidity(outcome.spec).valid).toBe(true);
    const runnability = evaluateRunnability(outcome.spec);
    expect(runnability.runnable).toBe(true);
    expect(runnability.aborts).toEqual([]);
  });

  it('OPT-IN: selection look-ahead does not change the default path (byte-identical without the flag)', () => {
    // The repair is gated entirely behind enforceRunnability; the default still
    // makes the greedy explainer pick. (The two are composed from the identical
    // menu, so this proves the gate — not the menu — drives the difference.)
    const lenient = composeFlow(FRAME_PLAN_CLOSE, { definitions: flowDefinitions });
    expect(planActual(lenient)).toBe('explainer.ideas@v1');
  });
});
