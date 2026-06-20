// Flow-shape composition (experimental, default-OFF): the bounded-loop shape.
//
// The composer was a pure LINEARIZER — it filled a hand-ordered role set with
// registered actuals and emitted strictly forward routes (continue -> next).
// It had never emitted a back-edge, so it could only ever produce a line, while
// the shipped fix flow hand-authors a bounded inspect->fix->verify LOOP
// (fix-verify routes `retry: 'fix-act'`).
//
// These tests lock the first non-linear shape the composer can PROPOSE: a role
// may carry `loopBackTo`, and the composer emits a bounded back-edge
// (`retry: <upstream step>`) on that role's step. The offline floor (assemble +
// compile + catalog gate) must accept the result — the graph-proposer spike
// proved it does for a hand-injected edge; here the COMPOSER emits it.
//
// They also lock the measurement side: `evaluateTopology` sees the route graph
// (back-edges, branch points) so a loop is finally distinguishable from a line.
// `evaluateNovelty`'s locked, pre-registered (block,kind)-sequence rubric is
// untouched: a loop adds no block, so it reports the SAME sequence — which is
// exactly why a topology-aware signal is needed.

import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import {
  type CompositionRoleSet,
  RESEARCH_THEN_BUILD,
  composeFlow,
  evaluateNovelty,
  evaluateTopology,
  evaluateValidity,
} from '../../src/flows/composition/index.js';
import { projectWorkContractProjectionV0 } from '../../src/shared/work-contract-projection.js';

// RESEARCH_THEN_BUILD with one added directive: the verify step loops back to
// the act step on a `retry` outcome — a bounded inspect->fix->verify loop.
const RESEARCH_THEN_BUILD_LOOP: CompositionRoleSet = {
  ...RESEARCH_THEN_BUILD,
  id: 'research-then-build-loop',
  title: 'Research then Build (bounded verify loop)',
  roles: RESEARCH_THEN_BUILD.roles.map((role) =>
    role.block === 'run-verification' ? { ...role, loopBackTo: 'act' } : role,
  ),
};

describe('flow-shape composition — bounded loop', () => {
  const linear = composeFlow(RESEARCH_THEN_BUILD, { definitions: flowDefinitions });
  const looped = composeFlow(RESEARCH_THEN_BUILD_LOOP, { definitions: flowDefinitions });

  it('composes the looped role set without a wall', () => {
    if (!looped.ok) {
      throw new Error(
        `composer walled: ${looped.walls.map((w) => `${w.block}: ${w.reason}`).join(' | ')}`,
      );
    }
    expect(looped.ok).toBe(true);
  });

  it('emits a bounded back-edge: verify.retry -> act', () => {
    if (!looped.ok) throw new Error('compose failed');
    const verify = looped.spec.items.find((it) => String(it.block) === 'run-verification');
    if (!verify) throw new Error('no run-verification step');
    // The act step's id is what the back-edge must target.
    const act = looped.spec.items.find((it) => String(it.block) === 'act');
    if (!act) throw new Error('no act step');
    expect(verify.routes.retry).toBe(String(act.id));
    // Forward + stop routes are preserved; only the back-edge is added.
    expect(verify.routes.continue).toBeDefined();
    expect(verify.routes.stop).toBe('@stop');
  });

  it('the looped spec is VALID by the real engine gates', () => {
    if (!looped.ok) throw new Error('compose failed');
    const validity = evaluateValidity(looped.spec);
    if (!validity.valid) {
      throw new Error(
        `not valid: compiles=${validity.compiles} catalogIssues=${validity.catalogIssueCount} primary=${validity.boundPrimaryResult} error=${validity.error ?? 'none'} issues=${validity.catalogIssues.join(' ; ')}`,
      );
    }
    expect(validity.valid).toBe(true);
  });

  it('a loopBackTo with no upstream producer walls honestly', () => {
    const badLoop: CompositionRoleSet = {
      ...RESEARCH_THEN_BUILD,
      id: 'bad-loop',
      // The frame role (first step) cannot loop back to `act`: no act step
      // exists upstream of it. The composer must wall, not emit a dangling edge.
      roles: RESEARCH_THEN_BUILD.roles.map((role, index) =>
        index === 0 ? { ...role, loopBackTo: 'act' } : role,
      ),
    };
    const outcome = composeFlow(badLoop, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.walls.some((w) => /loop/i.test(w.reason))).toBe(true);
    }
  });

  it('evaluateTopology distinguishes the loop from the line', () => {
    if (!linear.ok || !looped.ok) throw new Error('compose failed');
    const linValidity = evaluateValidity(linear.spec);
    const loopValidity = evaluateValidity(looped.spec);
    if (!linValidity.schematic || !loopValidity.schematic) throw new Error('no schematic');

    const linTopo = evaluateTopology(linValidity.schematic);
    const loopTopo = evaluateTopology(loopValidity.schematic);

    expect(linTopo.hasLoop).toBe(false);
    expect(loopTopo.hasLoop).toBe(true);
    expect(loopTopo.backEdges.length).toBe(1);
    expect(loopTopo.backEdges[0]?.route).toBe('retry');
    // The signature must differ — this is the whole point: a loop is a
    // different process than a line over the same blocks.
    expect(linTopo.signature).not.toBe(loopTopo.signature);
  });

  it('the back-edge is LIVE and BOUNDED: it projects a narrow_scope recovery binding for failed_check', () => {
    // Validity proves the loop COMPILES; this proves it RUNS. A composed
    // `retry` route is not a dead declaration — the work-contract projection
    // auto-derives a recovery binding for it, exactly as it does for the
    // hand-authored fix flow. On a failed verification (cause `failed_check`)
    // the runtime's recovery selection returns `retry` and loops back to act;
    // the binding's attempt budget (`must_respect_max_attempts`) bounds it. This
    // is the difference between a valid-but-dead route and a real loop.
    if (!looped.ok) throw new Error('compose failed');
    const validity = evaluateValidity(looped.spec);
    if (!validity.schematic) throw new Error('no schematic');
    const compiled = compileSchematicToCompiledFlow(validity.schematic);
    const flow = compiled.kind === 'single' ? compiled.flow : [...compiled.flows.values()][0];
    if (!flow) throw new Error('no compiled flow');

    const verify = looped.spec.items.find((it) => String(it.block) === 'run-verification');
    const act = looped.spec.items.find((it) => String(it.block) === 'act');
    const projection = projectWorkContractProjectionV0({ flow });
    const binding = projection.work_contract.recovery.find(
      (b) => b.step_id === String(verify?.id) && b.route_id === 'retry',
    );
    expect(binding).toBeDefined();
    expect(binding?.kind).toBe('narrow_scope');
    expect(binding?.route_target).toBe(String(act?.id));
    // The cause a failed verification raises must be one the binding accepts,
    // else the loop never fires.
    expect(binding?.allowed_failure_causes).toContain('failed_check');
    // Bounded: the runtime cycle guard caps re-entry by max_attempts.
    expect(binding?.attempt_budget.must_respect_max_attempts).toBe(true);
  });

  it('evaluateNovelty (locked rubric) is unchanged: loop reports the SAME sequence as the line', () => {
    if (!linear.ok || !looped.ok) throw new Error('compose failed');
    const linSchem = evaluateValidity(linear.spec).schematic;
    const loopSchem = evaluateValidity(looped.spec).schematic;
    if (!linSchem || !loopSchem) throw new Error('no schematic');
    const linNov = evaluateNovelty(linSchem, flowDefinitions);
    const loopNov = evaluateNovelty(loopSchem, flowDefinitions);
    // Same blocks in the same order => identical sequence under the locked
    // (block,kind) rubric. This documents the blind spot the topology signal fills.
    expect(loopNov.sequence).toBe(linNov.sequence);
  });
});
