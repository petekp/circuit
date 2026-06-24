// Flow-shape composition (experimental, default-OFF): the build-brief SELF-HEAL.
//
// build.plan@v1's compose writer REQUIRES reading build.brief@v1, which is
// CHECKPOINT-ONLY — produced solely by the `frame` block run as a checkpoint (the
// brief the operator blesses before any work begins). When a proposed role set
// binds a build `plan` but opens with a PLAIN COMPOSE frame, build.brief@v1 has no
// producer. The composition still assembles, but it is not runnable: it aborts at
// `plan` ("expected exactly one report writer for schema 'build.brief@v1', found
// 0"). The generate path hits exactly this about one time in three, because the
// proposer model varies whether it opens with the blessed-brief checkpoint.
//
// RESEARCH_THEN_BUILD is that walling shape, already committed: a research front
// (compose frame -> gather -> plan) welded to a build back, where the plan binds
// build.plan@v1 but the frame is a plain compose. composeFlow assembles it, and
// evaluateRunnability reports the build.brief@v1 abort — the same split the
// generate floor sees (it composes WITHOUT enforceRunnability, then runs the
// runnability gate separately).
//
// The existing family-coherence repair cannot close this: it reselects among
// families at the role's EXISTING execution kind, but build.brief@v1 needs the
// frame's kind ITSELF flipped from compose to checkpoint. (Confirmed offline:
// promoting only the frame to a checkpoint makes RESEARCH_THEN_BUILD fully
// runnable — the gather-context researcher does not starve on the changed brief.)
// This file locks the self-heal: under the opt-in enforceRunnability gate, the
// composer restores the blessed-brief checkpoint opener so the composed build arc
// runs instead of walling. It stays STRICTLY opt-in — the default path, and every
// shipped built-in's bytes, is unchanged.

import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  RESEARCH_THEN_BUILD,
  composeFlow,
  evaluateRunnability,
  evaluateValidity,
} from '../../src/flows/composition/index.js';

describe('composition build-brief self-heal — restore the blessed-brief checkpoint opener', () => {
  it('self-heals the compose-frame build arc to a RUNNABLE flow under enforceRunnability', () => {
    const outcome = composeFlow(RESEARCH_THEN_BUILD, {
      definitions: flowDefinitions,
      enforceRunnability: true,
    });
    if (!outcome.ok) {
      throw new Error(
        `expected a self-healed composition, got walls: ${outcome.walls
          .map((w) => w.reason)
          .join(' | ')}`,
      );
    }
    expect(evaluateValidity(outcome.spec).valid).toBe(true);
    expect(evaluateRunnability(outcome.spec).runnable).toBe(true);
  });

  it('restores the approval-gate opener: the frame becomes a CHECKPOINT producing build.brief@v1', () => {
    const outcome = composeFlow(RESEARCH_THEN_BUILD, {
      definitions: flowDefinitions,
      enforceRunnability: true,
    });
    if (!outcome.ok) throw new Error('expected a self-healed composition, got walls');
    const schematic = evaluateValidity(outcome.spec).schematic;
    if (schematic === undefined) throw new Error('no schematic');

    const frame = schematic.items.find((item) => String(item.id) === 'frame');
    if (frame === undefined) throw new Error('no frame step in the composed arc');
    // The self-heal flips the opener to the blessed-brief checkpoint that produces
    // build.brief@v1 — the same opener the built-in build flow carries.
    expect(frame.execution.kind).toBe('checkpoint');
    expect(String(frame.output)).toBe('build.brief@v1');

    // The plan still binds the build family and reads that brief — the self-heal
    // makes the producer exist, it does not abandon the build shape.
    const plan = schematic.items.find((item) => String(item.id) === 'plan');
    expect(String(plan?.output)).toBe('build.plan@v1');
  });

  it('OPT-IN: without enforceRunnability the arc is unchanged — compose frame, still not runnable', () => {
    const outcome = composeFlow(RESEARCH_THEN_BUILD, { definitions: flowDefinitions });
    if (!outcome.ok) throw new Error('default compose unexpectedly walled');
    const schematic = evaluateValidity(outcome.spec).schematic;
    if (schematic === undefined) throw new Error('no schematic');

    const frame = schematic.items.find((item) => String(item.id) === 'frame');
    // The repair is strictly gated: with no flag the composer must NOT promote the
    // opener, so the default path (and every shipped built-in's bytes) is untouched.
    expect(frame?.execution.kind).toBe('compose');
    expect(String(frame?.output)).not.toBe('build.brief@v1');
    // And the wall is still THERE on the default path — the heal does not leak into
    // the un-flagged route. This is the same state the generate floor detects today.
    expect(evaluateRunnability(outcome.spec).runnable).toBe(false);
  });
});
