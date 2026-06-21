// Flow-shape composition (experimental, default-OFF): READABLE CHECKPOINT OUTPUT
// — the build-family reachability fix (Phase B).
//
// The build family opens on a CHECKPOINT frame: the `frame` block run as a
// checkpoint produces build.brief@v1, the brief the operator blesses before any
// work starts. That brief is content, not just a routing decision — `plan` reads
// it (its compose writer requires build.brief@v1) and the close soaks it forward.
//
// A composed checkpoint historically wrote only its request/response routing
// paths, never a report_path. So the brief it "produced" had no read path, and the
// compile WALLED the instant a downstream step tried to read it:
//   "schematic item 'frame' produces 'build.brief@v1' but has no
//    writes.report_path or writes.result_path — downstream consumers cannot find a
//    read path".
// The real build flow's frame-step writes reports/build/brief.json ALONGSIDE its
// checkpoint paths — the schema explicitly allows report_path on a checkpoint. The
// fix gives a composed checkpoint the same readable report_path, so a checkpoint is
// both a routing gate AND a content producer, exactly as the shipping build flow's
// frame is.
//
// This file locks: (A) BUILD_LINEAR_FULL composes, compiles (valid), and is
// runnable end to end; (B) the frame checkpoint writes a report_path AND both
// checkpoint paths, and that output reads as a readable contract; (C) the brief is
// actually wired into plan's input (the consumer that forced the read path); and
// (D) the change touches only checkpoints — RESEARCH_THEN_BUILD (plain-compose
// frame, brief still unproduced) and GOAL_CLARIFY_THEN_FIX (no checkpoint) keep
// their exact prior verdicts.

import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  BUILD_LINEAR_FULL,
  GOAL_CLARIFY_THEN_FIX,
  RESEARCH_THEN_BUILD,
  composeFlow,
  evaluateRunnability,
  evaluateValidity,
  outputIsReadableContract,
} from '../../src/flows/composition/index.js';

describe('composition readable checkpoint — the build-family reachability fix', () => {
  it('A: BUILD_LINEAR_FULL composes, compiles, and runs end to end', () => {
    const outcome = composeFlow(BUILD_LINEAR_FULL, { definitions: flowDefinitions });
    if (!outcome.ok) {
      throw new Error(`walls: ${outcome.walls.map((w) => `${w.block}: ${w.reason}`).join(' | ')}`);
    }

    // The frame checkpoint binds the build family's own brief actual.
    const frameSel = outcome.selections.find((s) => s.block === 'frame');
    expect(frameSel?.actual).toBe('build.brief@v1');
    expect(frameSel?.executionKind).toBe('checkpoint');

    // Compiles — read-path resolution finds the brief's producer path. Before the
    // fix this is false with the "no writes.report_path" error; the canonical
    // validity check IS the compile, so .valid === true is the read-path coherence
    // proof (a checkpoint with no report_path would fail here).
    const validity = evaluateValidity(outcome.spec);
    if (!validity.valid) throw new Error(`invalid: ${validity.error}`);
    expect(validity.valid).toBe(true);

    // Runnable end to end — every required compose read has a producer and a wired
    // read, including plan's required build.brief@v1.
    const runnability = evaluateRunnability(outcome.spec);
    if (!runnability.runnable) {
      throw new Error(`not runnable; aborts: ${JSON.stringify(runnability.aborts)}`);
    }
    expect(runnability.runnable).toBe(true);
    expect(runnability.aborts).toEqual([]);
  });

  it('B: the frame checkpoint writes a report_path AND both checkpoint paths — it is gate AND producer', () => {
    const outcome = composeFlow(BUILD_LINEAR_FULL, { definitions: flowDefinitions });
    if (!outcome.ok) throw new Error('compose failed');

    const frameStep = outcome.spec.items.find((it) => String(it.block) === 'frame');
    if (frameStep === undefined) throw new Error('no frame step');
    const writes = frameStep.writes as Record<string, unknown> | undefined;

    // The routing paths a checkpoint always carries.
    expect(writes?.checkpoint_request_path).toBeDefined();
    expect(writes?.checkpoint_response_path).toBeDefined();
    // The readable report a CONTENT checkpoint also carries — the fix.
    expect(writes?.report_path).toBeDefined();

    // The engine's own readability predicate (keyed on the WRITE, never the kind)
    // now sees the checkpoint as a readable producer, so the terminal soak treats
    // its output like any other readable contract.
    expect(outputIsReadableContract(writes)).toBe(true);

    // A checkpoint that writes a report MUST carry policy.report_template (the
    // compiler enforces this), and the live build checkpoint writer parses that
    // template for a non-empty scope + success_criteria. The composer sources the
    // template verbatim from the donor (the build frame), so the live arm can
    // actually populate the brief, not merely compile. report_path and
    // report_template stay in lockstep: present together, absent together. (The
    // shape is asserted inline rather than via the build schema to keep this
    // composition test off a build-flow internal — the engine↔flow boundary.)
    const policy = (frameStep as { checkpointPolicy?: Record<string, unknown> }).checkpointPolicy;
    const template = policy?.report_template as
      | { scope?: unknown; success_criteria?: unknown }
      | undefined;
    expect(typeof template?.scope).toBe('string');
    expect((template?.scope as string).length).toBeGreaterThan(0);
    expect(Array.isArray(template?.success_criteria)).toBe(true);
    expect((template?.success_criteria as unknown[]).length).toBeGreaterThan(0);
    for (const criterion of template?.success_criteria as unknown[]) {
      expect(typeof criterion).toBe('string');
      expect((criterion as string).length).toBeGreaterThan(0);
    }
  });

  it('C: the brief is wired into plan input — the consumer that forced the read path', () => {
    const outcome = composeFlow(BUILD_LINEAR_FULL, { definitions: flowDefinitions });
    if (!outcome.ok) throw new Error('compose failed');

    const planStep = outcome.spec.items.find((it) => String(it.block) === 'plan');
    if (planStep === undefined) throw new Error('no plan step');
    // plan's compose writer requires reading build.brief@v1; Phase C's wiring pass
    // placed it, and this fix gives it a resolvable path.
    expect(Object.values(planStep.input ?? {})).toContain('build.brief@v1');
  });

  it('D: the change is checkpoint-only — non-checkpoint shapes keep their exact prior verdicts', () => {
    // RESEARCH_THEN_BUILD frames with a PLAIN compose (a generic brief, never
    // build.brief@v1), so plan's required build.brief@v1 read is still unproduced:
    // composes ok, NOT runnable, aborts at plan. Untouched by a checkpoint-only fix.
    const research = composeFlow(RESEARCH_THEN_BUILD, { definitions: flowDefinitions });
    expect(research.ok).toBe(true);
    if (research.ok) {
      const run = evaluateRunnability(research.spec);
      expect(run.runnable).toBe(false);
      expect(run.aborts.some((abort) => abort.stepId === 'plan')).toBe(true);
    }

    // GOAL_CLARIFY_THEN_FIX has no checkpoint at all, so it stays runnable end to
    // end exactly as Phase C locked it.
    const goal = composeFlow(GOAL_CLARIFY_THEN_FIX, { definitions: flowDefinitions });
    expect(goal.ok).toBe(true);
    if (goal.ok) {
      const run = evaluateRunnability(goal.spec);
      expect(run.runnable).toBe(true);
      expect(run.aborts).toEqual([]);
    }
  });
});
