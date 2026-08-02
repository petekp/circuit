// A spent retry budget must not bin the work.
//
// `exhaustion_route` was optional and its absence meant "abort the run". That is
// the same fail-open shape the terminal-outcome honesty flag had: the safe
// answer had to be remembered, forgetting was silent, and the failure always
// went the same way. It had been remembered 7 times out of 37.
//
// The declaration is kept, because a flow that wants a specific fallback should
// be able to say so. What changed is the default. Every step already declares a
// `stop` route, and no `stop` route in the catalog targets '@complete', so the
// engine can resolve one without asking: exhaustion takes the step's own stop
// route, which lands on a close step where the flow has one and on '@stop'
// otherwise. Either way the run closes `stopped` -- honest, degraded, and with
// its reports handed over -- rather than reading as a crash.
import { describe, expect, it } from 'vitest';

import { flowDefinitions } from '../../src/flows/catalog.js';
import { resolvedExhaustionRoute } from '../../src/runtime/run/run-transition.js';

// The route names that carry recovery mechanics. Kept as a literal here rather
// than imported: this file is the statement of the guarantee, so widening the
// set elsewhere should have to come here and argue for itself.
const RECOVERY_ROUTE = /(?:retry|revise|repair|rework|recover)/;

describe('resolvedExhaustionRoute', () => {
  it('honors an explicit declaration over the derived default', () => {
    expect(
      resolvedExhaustionRoute({
        exhaustionRoute: 'continue',
        routes: { continue: 'next', retry: 'self', stop: '@stop' },
      }),
    ).toBe('continue');
  });

  it('falls back to the step stop route when nothing is declared', () => {
    expect(
      resolvedExhaustionRoute({
        routes: { continue: 'next', retry: 'self', stop: '@stop' },
      }),
    ).toBe('stop');
  });

  it('resolves nothing when the step has neither, so the abort path is unchanged', () => {
    expect(resolvedExhaustionRoute({ routes: { continue: 'next' } })).toBeUndefined();
  });

  it('never resolves a route that would close the run as a success', () => {
    // The whole point of the fallback is an honest degraded close. A stop route
    // wired to '@complete' would turn a spent budget into a green run, which is
    // exactly the lie the schema already refuses for an explicit
    // exhaustion_route. The derived one must refuse it too.
    expect(
      resolvedExhaustionRoute({
        routes: { continue: 'next', retry: 'self', stop: '@complete' },
      }),
    ).toBeUndefined();
  });
});

// The catalog gate. Enumerates the live flows rather than a hand-kept list, so
// a flow authored tomorrow is enrolled with no action by its author and this
// turns red the day a step lands that can bin its own work.
describe('no step in the catalog can bin its work on a spent retry budget', () => {
  const recoverySteps = flowDefinitions.flatMap((definition) =>
    definition.schematic.items
      .filter((item) => Object.keys(item.routes).some((route) => RECOVERY_ROUTE.test(route)))
      .map((item) => ({ flowId: definition.id, item })),
  );

  it('finds recovery steps to check, so this cannot pass vacuously', () => {
    expect(recoverySteps.length).toBeGreaterThan(0);
  });

  for (const { flowId, item } of recoverySteps) {
    it(`${flowId}/${item.id} resolves an exhaustion route`, () => {
      const resolved = resolvedExhaustionRoute({
        ...(item.exhaustion_route === undefined ? {} : { exhaustionRoute: item.exhaustion_route }),
        routes: item.routes,
      });
      expect(
        resolved,
        `${flowId}/${item.id} declares a recovery route but would abort the whole run when that budget is spent, discarding every report the run wrote. Give the step a 'stop' route, or declare an explicit exhaustion_route.`,
      ).toBeDefined();
    });
  }
});

// The same rule at the other door. A fanout step whose join does not pass has
// run every branch and written the aggregate; if it cannot resolve a route it
// throws, the graph runner reports "handler threw", and the run aborts over
// work that is sitting on disk. A collapsed tournament with one good proposal
// in it is the case this was written for.
describe('no fanout step in the catalog can bin its work on a collapsed join', () => {
  const fanoutSteps = flowDefinitions.flatMap((definition) =>
    definition.schematic.items
      .filter((item) => item.execution?.kind === 'fanout')
      .map((item) => ({ flowId: definition.id, item })),
  );

  it('finds fanout steps to check, so this cannot pass vacuously', () => {
    expect(fanoutSteps.length).toBeGreaterThan(0);
  });

  for (const { flowId, item } of fanoutSteps) {
    it(`${flowId}/${item.id} resolves a route for a join that does not pass`, () => {
      expect(
        resolvedExhaustionRoute({
          ...(item.exhaustion_route === undefined
            ? {}
            : { exhaustionRoute: item.exhaustion_route }),
          routes: item.routes,
        }),
        `${flowId}/${item.id} fans out but has nowhere to go when the branches do not come together, so the run would abort and discard the aggregate and every branch that did answer. Give the step a 'stop' route.`,
      ).toBeDefined();
    });
  }
});
