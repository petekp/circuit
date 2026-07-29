// A4 (typed vocabulary): the closed-pantry LOCK TEST.
//
// This is a REGRESSION / LOCK test, not a failing-test-first build. The state it
// pins is ALREADY correct: M8.2 (uniform producer generics) and M9-A1 (raw
// consumed generics) typed every contract a shipped flow could mis-stitch, and
// the two fail-closed typing gates — collectConsumedDivergenceIssues (M8.4
// anti-widening) and collectUnregisteredConsumedContractIssues (M9-A1
// single-actual) — are BOTH inert across every shipped flow today. There is no
// uniform-spine generic left unresolved, and no divergent write-only umbrella has
// been force-typed (force-typing one would trip the anti-widening gate). A4
// therefore adds NO new typing. Its deliverable is this test: it makes the
// "M9 already stocked the pantry" finding executable, and it would FAIL the moment
// a future change regressed the pantry in either direction.
//
// What "the pantry is closed" means, made into a partition over the contract
// vocabulary. Enumerate every generic contract name the shipped block model uses
// (FLOW_BLOCK_DEFINITIONS: output_contract + input_contracts +
// alternative_input_contracts) and resolve each through the catalog-backed
// resolveFieldSignature. The names split into RESOLVED (a registered Zod body
// exists) and UNRESOLVED (none does). The lock is on the UNRESOLVED set: it must
// equal EXACTLY the set of names that are LEGITIMATELY exempt from the typing
// gates — the engine initial-only seams plus the write-only umbrellas. No name
// outside those exempt classes may be unresolved.
//
// Two failure directions this test catches:
//   (a) someone force-types a write-only umbrella (e.g. registers a body for
//       verification.result@v1). The name leaves UNRESOLVED, so UNRESOLVED no
//       longer equals the documented exempt union → this test fails. (The
//       anti-widening gate would also start failing on the now-divergent typed
//       generic, but this test fails first and names the regression plainly.)
//   (b) a uniform spine generic regresses to unresolved (e.g. a goal.child-run@v1
//       registration is dropped). The name enters UNRESOLVED but belongs to no
//       exempt class → this test fails.
//
// ONE write-only umbrella is DELIBERATELY typed and therefore RESOLVED:
// flow.result@v1, the close block's default output. The genuine-linear-LIVE
// unlock registered a loose body for it (mirroring fanout.aggregate@v1, #126) so
// the engine's reads-agnostic generic close builder can emit it as a composed
// linear flow's terminal. This does NOT trip direction (a)'s anti-widening
// concern: flow.result@v1 is the terminal OUTPUT and is never CONSUMED via the
// generic name, so the gate has nothing to inspect (the "both gates stay inert"
// PRIMARY assertion proves this stays true). It therefore moves from the exempt
// UNRESOLVED set into RESOLVED, and the partition below reflects that.
//
// The PRIMARY assertion is the partition rule (UNRESOLVED === documented exempt
// union, and the two typing gates stay inert). A snapshot of the exact resolved /
// unresolved name lists is a SECONDARY assertion, for legibility and to make a
// drift in the raw counts obvious in the diff.

import { describe, expect, it } from 'vitest';

import {
  collectConsumedDivergenceIssues,
  collectUnregisteredConsumedContractIssues,
} from '../../src/flows/accommodation-ledger.js';
import { resolveFieldSignature } from '../../src/flows/contract-body-signature.js';
import { FLOW_BLOCK_DEFINITIONS } from '../../src/schemas/flow-block-definitions.js';
import { shippedFlowSchematics } from '../helpers/in-memory-schematics.js';

// ---------------------------------------------------------------------------
// The documented exempt classes, sourced from accommodation-ledger.ts. These are
// the ONLY names a shipped flow may leave unresolved. Each name carries a
// gate-faithful reason it is exempt; the union of the three classes is the
// expected UNRESOLVED set.
// ---------------------------------------------------------------------------

// Class 1 — CONSUMED engine initial-only seams. A contract supplied solely by
// initial_contracts and read as an item input, with NO in-flow producer. It has
// no producer->consumer binding an assembler could mis-stitch, so its body is the
// engine's to own, not the flow's. The single-actual typing gate exempts these by
// construction (it never inspects a contract no item produces). Documented in
// collectUnregisteredConsumedContractIssues' exempt-populations note.
const INITIAL_ONLY_SEAMS: readonly string[] = [
  'context.packet@v1',
  'context.request@v1',
  'flow.brief@v1',
  'flow.state@v1',
  'verification.plan@v1',
];

// Class 2 — CONSUMED multi-actual generics. A generic read by an item input that
// the anti-widening gate (M8.4) owns: it requires every actual to resolve and be
// UNIFORM. flow.question@v1 is consumed (the goal flow reads it) and multi-actual,
// and its actuals classify uniform, so the gate is inert. Listed separately
// because, unlike the write-only umbrellas, this generic IS consumed — the M8.4
// gate, not "binding is moot", is what keeps it safe. Tagged as a seam (it is
// also an initial contract) in the two-way exemption tagging below.
const CONSUMED_MULTI_ACTUAL_UNIFORM_SEAMS: readonly string[] = ['flow.question@v1'];

// Class 3 — WRITE-ONLY block-reuse umbrellas. A generic named only as a block
// output_contract (or an alias generic / in-flow output) that NO item reads via
// the generic name. Binding is moot because nothing consumes the generic, so its
// body need not resolve — whether the bodies behind it are divergent OR
// unresolved. This is the population both gates pass untouched by design (the
// anti-widening gate's "write-only block-reuse umbrellas" family, and the
// single-actual gate's "the gate never inspects a contract no item produces /
// consumes via the generic" note). Includes the divergent write-only umbrellas
// called out explicitly in the ledger (verification.result@v1, change.evidence@v1)
// plus every other output-only / write-only-aliased generic.
const WRITE_ONLY_UMBRELLAS: readonly string[] = [
  'batch.result@v1',
  'change.evidence@v1',
  'clarified.task@v1',
  'continuity.record@v1',
  'decision.answer@v1',
  'diagnosis.result@v1',
  'flow.evidence@v1',
  // flow.result@v1 is intentionally typed (genuine-linear-LIVE) and now RESOLVED;
  // see the header note and EXPECTED_RESOLVED below.
  'goal.checkpoint@v1',
  'prototype.checkpoint@v1',
  // Review's audit step used to register this generic as its own relay report,
  // which is what typed it. The step is now a fan-out: each branch reports
  // review.unit-verdict@v1 and the join writes review.audit-aggregate@v1, which
  // is what Review aliases the generic to. No flow reads the generic name raw
  // any more, so it joins the write-only umbrellas and both gates stay inert.
  'review.verdict@v1',
  'risk.decision@v1',
  'user.goal@v1',
  'verification.result@v1',
  'work.queue@v1',
];

// The full expected UNRESOLVED set: the union of the three exempt classes. The
// classes are disjoint by construction (a name is consumed-with-producer, or a
// consumed seam, or write-only — never two), which the test asserts.
const EXPECTED_UNRESOLVED = [
  ...INITIAL_ONLY_SEAMS,
  ...CONSUMED_MULTI_ACTUAL_UNIFORM_SEAMS,
  ...WRITE_ONLY_UMBRELLAS,
].sort();

// Two-way exemption tag, as the A4 finding reports it: every initial/seam-driven
// exemption is an `initial-only-seam`; every write-only exemption is a
// `write-only-umbrella`.
const SEAM_EXEMPT = new Set<string>([
  ...INITIAL_ONLY_SEAMS,
  ...CONSUMED_MULTI_ACTUAL_UNIFORM_SEAMS,
]);
const UMBRELLA_EXEMPT = new Set<string>(WRITE_ONLY_UMBRELLAS);

function exemptionTag(name: string): 'initial-only-seam' | 'write-only-umbrella' | 'UNEXPECTED' {
  if (SEAM_EXEMPT.has(name)) return 'initial-only-seam';
  if (UMBRELLA_EXEMPT.has(name)) return 'write-only-umbrella';
  return 'UNEXPECTED';
}

// Enumerate every generic contract name the shipped block model references, the
// same surface the vocab probe walks: each block's produced output plus all of
// its consumed inputs (primary and alternative).
function allBlockContractNames(): string[] {
  const names = new Set<string>();
  for (const block of FLOW_BLOCK_DEFINITIONS) {
    names.add(block.output_contract);
    for (const contract of block.input_contracts ?? []) names.add(contract);
    for (const alt of block.alternative_input_contracts ?? []) {
      for (const contract of alt) names.add(contract);
    }
  }
  return [...names].sort();
}

function partition(): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const name of allBlockContractNames()) {
    (resolveFieldSignature(name) === null ? unresolved : resolved).push(name);
  }
  return { resolved, unresolved };
}

describe('vocabulary pantry is closed (A4 lock test)', () => {
  it('the exempt classes are disjoint and internally well-formed', () => {
    // A name may belong to exactly one exempt class. If a future edit duplicates
    // a name across classes, the union below would silently double-count and the
    // partition assertion would lie; this guards that invariant.
    const all = [
      ...INITIAL_ONLY_SEAMS,
      ...CONSUMED_MULTI_ACTUAL_UNIFORM_SEAMS,
      ...WRITE_ONLY_UMBRELLAS,
    ];
    expect(new Set(all).size, 'exempt classes overlap (a name appears twice)').toBe(all.length);
  });

  it('PRIMARY: the unresolved set equals exactly the documented exempt union', () => {
    const { unresolved } = partition();
    // The load-bearing partition assertion. If an umbrella is force-typed it
    // leaves this set (← regression direction (a)); if a uniform spine generic
    // regresses to unresolved it enters this set with no exempt class to claim it
    // (← regression direction (b)). Either way the equality breaks.
    expect(unresolved).toEqual(EXPECTED_UNRESOLVED);

    // And no unresolved name is UNEXPECTED — a stronger, name-by-name framing of
    // the same rule that points at the offending contract on failure.
    for (const name of unresolved) {
      expect(
        exemptionTag(name),
        `unresolved contract '${name}' is not a documented exempt seam or umbrella`,
      ).not.toBe('UNEXPECTED');
    }
  });

  it('PRIMARY: both fail-closed typing gates stay inert across every shipped flow', () => {
    // The executable form of "M9 already stocked the pantry". The partition rule
    // above is a static view; this is the dynamic one — the actual gates that
    // would reject a flow consuming an unresolved/divergent generic find nothing
    // to reject. If a uniform generic regresses or an umbrella is consumed
    // unsafely, one of these gates fires here too.
    const schematics = shippedFlowSchematics();
    for (const schematic of schematics) {
      expect(
        collectConsumedDivergenceIssues(schematic, resolveFieldSignature),
        `anti-widening gate (M8.4) found a consumed divergent/unresolved generic in '${schematic.id}'`,
      ).toEqual([]);
      expect(
        collectUnregisteredConsumedContractIssues(schematic, resolveFieldSignature),
        `single-actual typing gate (M9-A1) found a consumed+produced unregistered contract in '${schematic.id}'`,
      ).toEqual([]);
    }
  });

  it('SECONDARY: the exact resolved / unresolved name lists are snapshotted for legibility', () => {
    // A snapshot of the closed-pantry state at A4. The PRIMARY assertion is the
    // partition rule; this pins the raw lists so any drift in the vocabulary
    // surface (a new block contract, a renamed seam) shows up as a readable diff,
    // not just a count change. Update these lists deliberately when the pantry
    // legitimately gains or loses a contract.
    const { resolved, unresolved } = partition();

    const EXPECTED_RESOLVED = [
      'flow.catalog@v1',
      'flow.result@v1',
      'goal.attempt@v1',
      'goal.child-run@v1',
      'goal.contract@v1',
      'goal.evidence-evaluation@v1',
      'goal.gate-review@v1',
      'goal.recovery@v1',
      'goal.result@v1',
      'plan.strategy@v1',
      'prototype.variant-provider-evidence@v1',
      'pursuit.contract@v1',
      'pursuit.graph@v1',
      'review.intake@v1',
      'route.decision@v1',
      'task.intake@v1',
    ];

    expect(resolved).toEqual(EXPECTED_RESOLVED);
    expect(unresolved).toEqual(EXPECTED_UNRESOLVED);
    // Exact counts after Review's audit step became a fan-out: 36 total =
    // 16 resolved + 20 unresolved (review.verdict@v1 moved unresolved←resolved).
    expect(resolved.length).toBe(16);
    expect(unresolved.length).toBe(20);
    expect(resolved.length + unresolved.length).toBe(36);
  });

  it('logs the closed-pantry partition with each unresolved name tagged', () => {
    const { resolved, unresolved } = partition();
    const tagged = unresolved.map((name) => `  [${exemptionTag(name)}] ${name}`);
    console.log(
      `\nvocabulary pantry (A4 lock):\n  ${resolved.length} resolved / ${unresolved.length} unresolved (${resolved.length + unresolved.length} total)\n` +
        `  resolved: ${JSON.stringify(resolved)}\n  unresolved (tagged):\n${tagged.join('\n')}\n`,
    );
  });
});
