// M8 (first-class composition): structural signatures for contract bodies.
//
// The accommodation ledger surfaces multi-actual generics — one generic
// contract name aliased to several distinct actuals within a flow. Until M8 the
// ledger could only prove each actual had a real producer; it could NOT say
// whether the bodies behind those actuals were the same shape. This module
// closes that gap: it resolves an actual contract name to its Zod body and
// reduces that body to a canonical STRUCTURAL SIGNATURE, so the ledger can
// classify a multi-actual generic as uniform (all actuals share one shape) or
// divergent (the shapes differ).
//
// The signature is an EQUALITY key, not a subtype relation. Two bodies share a
// signature iff their JSON-Schema shape — field names with optionality,
// recursively through object property values, union variants, and arrays — is
// identical. (M9-A2 added the object-property-value recursion; before it, two
// bodies with the same field names but different field types hashed equal.) This
// is the report-only half of M8: it makes "needs split vs safe to unify" a
// machine output. The fail-closed half (the anti-widening gate) is M8.4.
//
// Why JSON Schema and not raw Zod introspection: the report bodies mix
// z.object, z.looseObject, discriminated unions, supersets, and `.extend`
// chains. Reducing through the same draft-07 conversion the connectors already
// use (responseJsonSchemaFromZod) gives one stable shape to read field names
// from, instead of branching on Zod internals per construct.

import type { z } from 'zod';
import { BUILTIN_REPORT_SCHEMAS } from '../schemas/builtin-report-schemas.js';
import { RunResult } from '../schemas/result.js';
import { BUILTIN_ROUTING_CONTRACT_SCHEMAS } from '../schemas/routing-contract-schemas.js';
import { responseJsonSchemaFromZod } from '../shared/zod-to-response-schema.js';
import { buildReportSchemaRegistry } from './catalog-derivations.js';
import { flowPackages } from './catalog.js';
import { GoalGate } from './goal/reports.js';
import { RuntimeProofCompose } from './runtime-proof/reports.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Canonical signature of a JSON-Schema node. Object → its sorted field names
// with `?` on the optional ones, EACH paired with the recursed signature of its
// value (`name:<sig>` / `name?:<sig>`); union → its variant signatures, sorted so
// declaration order does not matter; array → the element signature; anything
// else → its JSON-Schema `type` (or `scalar` when untyped). Recursing through
// object property values (M9-A2) is what stops two bodies with the same field
// names but different field types from hashing equal — the signature-collision
// seam an assembler would otherwise trip. Recursion through unions and arrays is
// what makes a discriminated union compare equal to another union of the same
// variants regardless of how each was authored.
function signatureOfNode(node: unknown): string {
  if (!isRecord(node)) return 'unknown';

  if (Array.isArray(node.anyOf)) {
    const variants = node.anyOf.map(signatureOfNode).sort();
    return `union(${variants.join('|')})`;
  }
  if (Array.isArray(node.allOf)) {
    const parts = node.allOf.map(signatureOfNode).sort();
    return `all(${parts.join('&')})`;
  }
  if (node.type === 'array') {
    return `array<${signatureOfNode(node.items)}>`;
  }
  if (node.type === 'object' && isRecord(node.properties)) {
    const required = new Set<string>(
      Array.isArray(node.required) ? (node.required as string[]) : [],
    );
    const properties = node.properties;
    const fields = Object.keys(properties)
      .sort()
      .map((key) => {
        const label = required.has(key) ? key : `${key}?`;
        return `${label}:${signatureOfNode(properties[key])}`;
      });
    return `{${fields.join(',')}}`;
  }
  if (typeof node.type === 'string') return node.type;
  return 'scalar';
}

// Reduce a Zod report body to its canonical structural signature.
export function fieldSignature(schema: z.ZodType): string {
  return signatureOfNode(responseJsonSchemaFromZod(schema));
}

// Uniform producer generics (M8.2). A producer generic is a block
// output_contract realized by several actuals within one flow. When all those
// actuals share one body the generic is UNIFORM, and its single canonical body
// is that shared shape. Two ship today, both in goal:
//   - goal.child-run@v1   → RunResult (the goal-child-run block; five child
//                           results, all RunResult)
//   - goal.gate-review@v1 → GoalGate  (the goal-gate-review block; two passes,
//                           both GoalGate)
// Only the actuals were typed (they are flow reports); the generic NAME they
// collapse under was not, so resolveFieldSignature returned null for it. These
// entries close that gap. The body is the SAME Zod schema the actuals use
// (imported, never re-authored) so the two cannot drift apart silently — the
// "canonical body equals every actual" invariant is pinned in
// accommodation-ledger.test.ts. Divergent producer generics (goal.contract@v1,
// the verification families) get NO entry here on purpose: they have no single
// canonical body, which is what forces their split in M8.3.
const UNIFORM_PRODUCER_GENERIC_SCHEMAS: Readonly<Record<string, z.ZodType<unknown>>> = {
  'goal.child-run@v1': RunResult,
  'goal.gate-review@v1': GoalGate,
};

// Raw consumed generics (M9-A1). A generic block output_contract that a flow
// CONSUMES raw — read by an item input under the generic name, produced in-flow,
// and NOT specialized to a flow-scoped actual — needs a canonical body so the
// single-actual typing gate (collectUnregisteredConsumedContractIssues) can
// verify the consumer reads a known shape. One ships today:
//   - plan.strategy@v1  → RuntimeProofCompose  (runtime-proof: compose-step
//                          outputs it, relay-step reads it as `plan`)
// The body is the SAME Zod schema the producing item writes (RuntimeProofCompose
// is the compose writer's result, runtime-proof.compose@v1), so the registration
// matches runtime truth and never re-authors a shape.
//
// `review.verdict@v1` used to be listed here for the same reason. It no longer
// needs to be: Review registers it as a real relay report on the audit step, so
// the ordinary report registry supplies the body and a second registration here
// would collide. That is the shape of the fix rather than an exception to it —
// an entry in this table means a contract the engine can type but a connector
// cannot be handed, so prefer registering the report.
const RAW_CONSUMED_GENERIC_SCHEMAS: Readonly<Record<string, z.ZodType<unknown>>> = {
  'plan.strategy@v1': RuntimeProofCompose,
};

// Every body the engine can resolve by contract NAME, in three parts:
//   1. report bodies — relay reports plus channel:'report' bodies (compose /
//      close / verification / checkpoint / sub-run). The narrower relay-only
//      registry that parseReport uses would miss most multi-actual actuals,
//      which are channel:'report' compose/verification bodies, so the resolver
//      builds over the broad relay+report coverage.
//   2. routing-seam contracts (M8.1) — task.intake / route.decision /
//      flow.catalog. These are engine built-ins, not flow-package reports, so
//      they merge in separately.
//   3. uniform producer generics (M8.2) — block output_contracts whose actuals
//      all share one body (see above).
//   4. raw consumed generics (M9-A1) — block output_contracts a flow consumes
//      raw (under the generic name), whose canonical body is the producing item's
//      report shape (see above).
// A name collision across any two parts is a bug (a generic masquerading as a
// flow report, or two sources claiming one name), so each merge throws on it.
const BODY_REGISTRY: Readonly<Record<string, z.ZodType<unknown>>> = (() => {
  const reports = buildReportSchemaRegistry(flowPackages, {
    channels: 'relay+report',
    fixtures: BUILTIN_REPORT_SCHEMAS,
  });
  const merged: Record<string, z.ZodType<unknown>> = { ...reports };
  const mergeBuiltins = (source: Readonly<Record<string, z.ZodType<unknown>>>, kind: string) => {
    for (const [name, schema] of Object.entries(source)) {
      if (Object.hasOwn(merged, name)) {
        throw new Error(`${kind} '${name}' collides with an already-registered contract body`);
      }
      merged[name] = schema;
    }
  };
  mergeBuiltins(BUILTIN_ROUTING_CONTRACT_SCHEMAS, 'routing-seam contract');
  mergeBuiltins(UNIFORM_PRODUCER_GENERIC_SCHEMAS, 'uniform producer generic');
  mergeBuiltins(RAW_CONSUMED_GENERIC_SCHEMAS, 'raw consumed generic');
  return Object.freeze(merged);
})();

// Resolve a contract/actual name to its body signature, or null when no
// registered body exists for it (e.g. a routing-seam contract before M8.1
// authors its body). Null is what the ledger reports as `unresolved`.
export function resolveFieldSignature(contractName: string): string | null {
  if (!Object.hasOwn(BODY_REGISTRY, contractName)) return null;
  return fieldSignature(BODY_REGISTRY[contractName] as z.ZodType);
}
