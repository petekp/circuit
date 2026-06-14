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
// signature iff their JSON-Schema shape — top-level field names with optionality,
// recursively through union variants and arrays — is identical. This is the
// report-only half of M8: it makes "needs split vs safe to unify" a machine
// output. The fail-closed half (the anti-widening gate) is M8.4.
//
// Why JSON Schema and not raw Zod introspection: the report bodies mix
// z.object, z.looseObject, discriminated unions, supersets, and `.extend`
// chains. Reducing through the same draft-07 conversion the connectors already
// use (responseJsonSchemaFromZod) gives one stable shape to read field names
// from, instead of branching on Zod internals per construct.

import type { z } from 'zod';
import { BUILTIN_REPORT_SCHEMAS } from '../schemas/builtin-report-schemas.js';
import { BUILTIN_ROUTING_CONTRACT_SCHEMAS } from '../schemas/routing-contract-schemas.js';
import { responseJsonSchemaFromZod } from '../shared/zod-to-response-schema.js';
import { buildReportSchemaRegistry } from './catalog-derivations.js';
import { flowPackages } from './catalog.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Canonical signature of a JSON-Schema node. Object → its sorted field names
// with `?` on the optional ones; union → its variant signatures, sorted so
// declaration order does not matter; array → the element signature; anything
// else → its JSON-Schema `type` (or `scalar` when untyped). Recursion is what
// makes a discriminated union compare equal to another union of the same
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
    const fields = Object.keys(node.properties)
      .sort()
      .map((key) => (required.has(key) ? key : `${key}?`));
    return `{${fields.join(',')}}`;
  }
  if (typeof node.type === 'string') return node.type;
  return 'scalar';
}

// Reduce a Zod report body to its canonical structural signature.
export function fieldSignature(schema: z.ZodType): string {
  return signatureOfNode(responseJsonSchemaFromZod(schema));
}

// Every body the engine can resolve by contract NAME, in two parts:
//   1. report bodies — relay reports plus channel:'report' bodies (compose /
//      close / verification / checkpoint / sub-run). The narrower relay-only
//      registry that parseReport uses would miss most multi-actual actuals,
//      which are channel:'report' compose/verification bodies, so the resolver
//      builds over the broad relay+report coverage.
//   2. routing-seam contracts (M8.1) — task.intake / route.decision /
//      flow.catalog. These are engine built-ins, not flow-package reports, so
//      they merge in separately. A name collision between the two is a bug
//      (a routing contract masquerading as a flow report), so it throws.
const BODY_REGISTRY: Readonly<Record<string, z.ZodType<unknown>>> = (() => {
  const reports = buildReportSchemaRegistry(flowPackages, {
    channels: 'relay+report',
    fixtures: BUILTIN_REPORT_SCHEMAS,
  });
  const merged: Record<string, z.ZodType<unknown>> = { ...reports };
  for (const [name, schema] of Object.entries(BUILTIN_ROUTING_CONTRACT_SCHEMAS)) {
    if (Object.hasOwn(merged, name)) {
      throw new Error(
        `routing-seam contract '${name}' collides with a flow report schema of the same name`,
      );
    }
    merged[name] = schema;
  }
  return Object.freeze(merged);
})();

// Resolve a contract/actual name to its body signature, or null when no
// registered body exists for it (e.g. a routing-seam contract before M8.1
// authors its body). Null is what the ledger reports as `unresolved`.
export function resolveFieldSignature(contractName: string): string | null {
  if (!Object.hasOwn(BODY_REGISTRY, contractName)) return null;
  return fieldSignature(BODY_REGISTRY[contractName] as z.ZodType);
}
