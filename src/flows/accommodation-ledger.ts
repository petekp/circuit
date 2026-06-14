// M1 (first-class composition): the script-backed accommodation ledger.
//
// Reaching catalog-zero by ADDING a contract alias is strictly worse than an
// honest report-only gap: it freezes two divergent models behind a green check.
// This ledger is the structural defense against that. Every contract_alias in
// every shipped flow must be a MODEL-CORRECTION -- it must cite a real producer:
// the in-flow item whose output IS the alias `actual`, or one of the flow's
// initial contracts. An alias that cannot cite a real producer is an
// ACCOMMODATION: it remaps a consumer's generic onto a contract nothing in the
// flow emits, papering over a structural gap.
//
// The M5 fail-closed compile-gate flip is FORBIDDEN while any ACCOMMODATION is
// outstanding (the accommodation count must be 0). This module is the
// machine-checkable gate; tests/contracts/accommodation-ledger.test.ts pins it.
//
// Scope and the widening half. The spec tracks "every alias / widening". This
// module owns the alias half -- the enumerable, explicitly-authored remap
// entries. The block-model widening half (a block's allowed_routes, stage
// allowlist, or execution kinds widened to fit a schematic) is owned by the
// catalog-check ratchet: tests/contracts/schematic-catalog-check.test.ts pins
// each flow's catalog-issue ceiling, so a widening that drifts from runtime
// truth reappears as an issue, and every shipped widening carries an inline
// justification citing the real route enum / execution kind / stage lock it
// describes. Together the two gates cover the whole accommodation surface.
//
// What this ledger does NOT prove, on two axes:
//   - Body divergence enforcement. `collectBodyDivergence` (M8.0, below) now
//     DETECTS whether the bodies behind a multi-actual generic share one shape
//     (uniform) or collapse structurally divergent bodies under one generic
//     name (divergent) — report-only. It is the data source for the fail-closed
//     anti-widening gate, which is M8.4: until that lands, a divergent generic
//     is surfaced, not rejected. The multi-actual generics stay visible as probe
//     targets, never silently blessed.
//   - Per-consumer binding. That a consumer reading the generic resolves to the
//     producer on ITS route. This ledger proves alias->producer EXISTENCE (the
//     actual is emitted somewhere in the flow); it does not prove the compiler
//     binds the right producer on each consumer's path. That read-edge
//     correctness is owned by M4 (the by-id-lookup dissolve) and M5 (the
//     fail-closed gate). "Zero accommodations" therefore means "no alias points
//     at a phantom contract", not "every binding is correct".

import type { FlowSchematic } from '../schemas/flow-schematic.js';

export type AliasClassification = 'model-correction' | 'accommodation';

export interface AliasLedgerEntry {
  readonly flow: string;
  readonly generic: string;
  readonly actual: string;
  readonly classification: AliasClassification;
  // model-correction: the in-flow producer that justifies the alias.
  // accommodation: null -- no item output and no initial contract emits `actual`.
  readonly citation: string | null;
}

export interface MultiActualGeneric {
  readonly flow: string;
  readonly generic: string;
  readonly actuals: readonly string[];
}

export interface AccommodationLedger {
  readonly entries: readonly AliasLedgerEntry[];
  readonly accommodations: readonly AliasLedgerEntry[];
  readonly multiActualGenerics: readonly MultiActualGeneric[];
}

// M8 body-divergence: one actual contract behind a multi-actual generic, paired
// with the structural signature of its body (null when no body resolves).
export interface BodyDivergenceActual {
  readonly actual: string;
  readonly signature: string | null;
}

// M8 body-divergence classification for one multi-actual generic:
//   - uniform:    every actual resolves to one and the same body signature.
//                 Safe to unify under a single typed contract.
//   - divergent:  the actuals resolve to two or more distinct signatures. The
//                 generic name spans structurally different bodies — the
//                 catch-all the anti-widening gate must forbid; needs a split.
//   - unresolved: at least one actual has no registered body, so the bodies
//                 cannot be compared yet (e.g. a routing-seam contract before
//                 its body is authored).
export type BodyDivergenceClassification = 'uniform' | 'divergent' | 'unresolved';

export interface MultiActualBodyDivergence {
  readonly flow: string;
  readonly generic: string;
  readonly classification: BodyDivergenceClassification;
  readonly actuals: readonly BodyDivergenceActual[];
}

// Resolve each alias against the flow's real producers. The citation names the
// item (and block) whose output is the alias `actual`, or the initial contract
// that supplies it. A null citation marks an accommodation.
export function collectFlowAliasLedger(schematic: FlowSchematic): AliasLedgerEntry[] {
  const flow = schematic.id;
  const producerByContract = new Map<string, string>();
  for (const item of schematic.items) {
    if (!producerByContract.has(item.output)) {
      producerByContract.set(
        item.output,
        `item "${item.id}" (block "${item.block}") outputs ${item.output}`,
      );
    }
  }
  for (const contract of schematic.initial_contracts) {
    if (!producerByContract.has(contract)) {
      producerByContract.set(contract, `initial_contract ${contract}`);
    }
  }
  return schematic.contract_aliases.map((alias) => {
    const citation = producerByContract.get(alias.actual) ?? null;
    return {
      flow,
      generic: alias.generic,
      actual: alias.actual,
      classification: citation === null ? 'accommodation' : 'model-correction',
      citation,
    } satisfies AliasLedgerEntry;
  });
}

// Pure over the in-memory definitions (M6): the caller supplies each flow's
// FlowSchematic (catalog.ts `flowDefinitions[*].schematic`), so the ledger
// analyzes the live source of truth rather than reading the generated
// src/flows/<id>/schematic.json back from disk. The committed JSON stays a
// drift-checked snapshot, not an input here.
export function collectAccommodationLedger(
  schematics: readonly FlowSchematic[],
): AccommodationLedger {
  const entries: AliasLedgerEntry[] = [];
  for (const schematic of schematics) entries.push(...collectFlowAliasLedger(schematic));

  const accommodations = entries.filter((entry) => entry.classification === 'accommodation');

  // Multi-actual generics: one generic name aliased to more than one distinct
  // actual within a single flow. Each is a body-divergence probe target for M8.
  const groupByKey = new Map<string, { flow: string; generic: string; actuals: Set<string> }>();
  for (const entry of entries) {
    const key = `${entry.flow}::${entry.generic}`;
    const group = groupByKey.get(key) ?? {
      flow: entry.flow,
      generic: entry.generic,
      actuals: new Set<string>(),
    };
    group.actuals.add(entry.actual);
    groupByKey.set(key, group);
  }
  const multiActualGenerics: MultiActualGeneric[] = [];
  for (const group of groupByKey.values()) {
    if (group.actuals.size > 1) {
      multiActualGenerics.push({
        flow: group.flow,
        generic: group.generic,
        actuals: [...group.actuals].sort(),
      });
    }
  }
  multiActualGenerics.sort((a, b) =>
    `${a.flow}::${a.generic}`.localeCompare(`${b.flow}::${b.generic}`),
  );

  return { entries, accommodations, multiActualGenerics };
}

// M8 (report-only): classify each multi-actual generic by whether the bodies
// behind its actuals share one structural shape. `resolveSignature` maps an
// actual contract name to its body signature (or null when unresolvable) — it
// is injected so this stays a pure analyzer with no catalog or Zod dependency;
// the catalog-backed resolver lives in contract-body-signature.ts. This is the
// data source the M8.4 anti-widening gate consumes: a generic that classifies
// `divergent` and is not made a discriminated union must be split.
export function collectBodyDivergence(
  generics: readonly MultiActualGeneric[],
  resolveSignature: (contractName: string) => string | null,
): MultiActualBodyDivergence[] {
  return generics.map((generic) => {
    const actuals = generic.actuals.map((actual) => ({
      actual,
      signature: resolveSignature(actual),
    }));
    const classification: BodyDivergenceClassification = actuals.some(
      (entry) => entry.signature === null,
    )
      ? 'unresolved'
      : new Set(actuals.map((entry) => entry.signature)).size === 1
        ? 'uniform'
        : 'divergent';
    return { flow: generic.flow, generic: generic.generic, classification, actuals };
  });
}

// M8.4 anti-widening gate: one consumed-divergence finding. A generic contract
// that is CONSUMED as an item input (its name appears as a value in some
// item.input) AND cannot be PROVEN to bind to a single body — classified
// `divergent` (two or more structurally-distinct bodies) or `unresolved` (at
// least one actual has no registered body) — is unsafe: a consumer reading the
// generic could bind to a shape the engine never verified.
export interface ConsumedDivergenceIssue {
  readonly flow: string;
  readonly generic: string;
  // Why the consumed generic is unsafe: `divergent` (>=2 distinct bodies) or
  // `unresolved` (>=1 actual with no registered body, so uniformity is unprovable).
  readonly classification: 'divergent' | 'unresolved';
  // Item ids whose input reads the generic name directly (sorted, deduped).
  readonly consumingItems: readonly string[];
  // The distinct RESOLVED body signatures behind the generic's actuals (sorted,
  // deduped). For `unresolved` this is the subset of actuals that did resolve.
  readonly signatures: readonly string[];
  // For `unresolved`: the actuals whose body could not be resolved (sorted,
  // deduped). Empty for `divergent`.
  readonly unresolvedActuals: readonly string[];
}

// M8.4 anti-widening gate (fail-closed). Forbids a generic that is CONSUMED as
// an item input AND cannot be PROVEN to bind to a single body — classified
// `divergent` (>=2 distinct bodies, the catch-all) OR `unresolved` (>=1 actual
// with no registered body, so uniformity is unprovable). Gating `unresolved`
// closes the masking hole an adversarial review found: without it, adding one
// alias from a divergent consumed generic to a real-but-bodyless contract flips
// the classification to `unresolved` and silences the gate — a false negative on
// a genuine widening, on exactly the composed/edited-flow population this gate
// exists to protect.
//
// Three families pass untouched, by design:
//   - write-only block-reuse umbrellas — a generic named only as a block
//     output_contract, realized by typed flow-scoped actuals, that no item reads
//     via the generic name. These are honest reuse (one block, many flows),
//     whether their bodies are divergent OR unresolved; binding is moot because
//     nothing reads the generic. The shipped flows' verification.result@v1 /
//     plan.strategy@v1 / change.evidence@v1 / review.verdict@v1 are all this. The
//     gate re-runs on every compile, so a composed flow that DOES consume one
//     unsafely is still caught.
//   - uniform generics — every actual shares one body, so binding is unambiguous.
//   - single-actual generics — one actual, nothing to disambiguate (this is
//     review.verdict@v1 inside the review flow: consumed, but one actual).
//
// Scope boundary (M9). This gate keys on multi-actual generics — `actuals.size
// > 1` in collectAccommodationLedger. A consumed generic with a SINGLE actual,
// or a bare consumed contract with no alias at all, never enters that set, so
// the gate never inspects its body. If that one body is unregistered/unverified,
// the gate is blind to it: this gate forbids the WIDENING shape (one name, many
// bodies), not the orthogonal "is every consumed body typed" question. Proving
// the whole contract universe has a registered body is the M9 typing pass; it
// would fail-closed on the eight built-ins today (several routing-seam contracts
// are consumed before their Zod body is authored), which is why it is out of
// scope here. The shipped flows are inert under both gates.
//
// `resolveSignature` is injected (the catalog-backed resolver lives in
// contract-body-signature.ts) so this stays a pure analyzer.
export function collectConsumedDivergenceIssues(
  schematic: FlowSchematic,
  resolveSignature: (contractName: string) => string | null,
): ConsumedDivergenceIssue[] {
  const ledger = collectAccommodationLedger([schematic]);
  const divergence = collectBodyDivergence(ledger.multiActualGenerics, resolveSignature);
  // A CONSUMED multi-actual generic must be provably uniform; anything that is
  // not `uniform` is unsafe to read through (see the masking-hole note above).
  const unsafeByGeneric = new Map(
    divergence
      .filter((entry) => entry.classification !== 'uniform')
      .map((entry) => [entry.generic, entry]),
  );
  if (unsafeByGeneric.size === 0) return [];

  // Which unsafe generics are read by name as an item input value, and by whom.
  const consumersByGeneric = new Map<string, string[]>();
  for (const item of schematic.items) {
    const itemId = item.id as unknown as string;
    for (const value of Object.values(item.input)) {
      const name = value as unknown as string;
      if (!unsafeByGeneric.has(name)) continue;
      const consumers = consumersByGeneric.get(name) ?? [];
      consumers.push(itemId);
      consumersByGeneric.set(name, consumers);
    }
  }

  const flow = schematic.id as unknown as string;
  const issues: ConsumedDivergenceIssue[] = [];
  for (const [generic, consumers] of consumersByGeneric) {
    const entry = unsafeByGeneric.get(generic);
    if (entry === undefined) continue;
    const signatures = [
      ...new Set(
        entry.actuals
          .map((actual) => actual.signature)
          .filter((signature): signature is string => signature !== null),
      ),
    ].sort();
    const unresolvedActuals = [
      ...new Set(
        entry.actuals.filter((actual) => actual.signature === null).map((actual) => actual.actual),
      ),
    ].sort();
    issues.push({
      flow,
      generic,
      classification: entry.classification === 'divergent' ? 'divergent' : 'unresolved',
      consumingItems: [...new Set(consumers)].sort(),
      signatures,
      unresolvedActuals,
    });
  }
  return issues.sort((a, b) => a.generic.localeCompare(b.generic));
}
