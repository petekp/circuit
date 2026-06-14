// M9-A2 (first-class composition): full-fidelity contract-body signatures.
//
// The M8 signature reduced an object body to its field NAMES + optionality but
// did NOT recurse into each field's value type, so two bodies with the same
// field names but different field types hashed equal -- the "signature collision"
// residual. An assembler could then treat two structurally distinct contracts as
// interchangeable under one generic name. These tests pin that the signature now
// distinguishes field value types (scalars, and nested element types reached
// THROUGH an object property), while still treating genuinely identical shapes as
// equal. The shipped-flow-neutrality of the change (the M8.2 uniform generics,
// which share one literal Zod body, still classify uniform) is pinned by the
// existing M8.2 tests in accommodation-ledger.test.ts.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fieldSignature } from '../../src/flows/contract-body-signature.js';

describe('contract-body signature fidelity (M9-A2)', () => {
  it('distinguishes object bodies that share field names but differ in scalar types', () => {
    // Same field names {count, id}, different scalar types. Under the M8 signature
    // both reduced to `{count,id}` and read as interchangeable. Full fidelity must
    // tell them apart.
    const a = z.object({ id: z.string(), count: z.number() }).strict();
    const b = z.object({ id: z.number(), count: z.string() }).strict();
    expect(fieldSignature(a)).not.toBe(fieldSignature(b));
  });

  it('distinguishes nested array element types reached through a property', () => {
    // The array branch already recursed into its items, but only when reached
    // directly; an array nested behind an object property was never descended into
    // (the object branch stopped at field names). Both reduced to `{rows}`.
    const a = z.object({ rows: z.array(z.object({ x: z.string() })) }).strict();
    const b = z.object({ rows: z.array(z.object({ x: z.number() })) }).strict();
    expect(fieldSignature(a)).not.toBe(fieldSignature(b));
  });

  it('distinguishes a nested object property shape', () => {
    const a = z.object({ meta: z.object({ name: z.string() }) }).strict();
    const b = z.object({ meta: z.object({ label: z.string() }) }).strict();
    expect(fieldSignature(a)).not.toBe(fieldSignature(b));
  });

  it('still treats two structurally identical bodies as equal', () => {
    const a = z.object({ id: z.string(), tags: z.array(z.string()) }).strict();
    const b = z.object({ id: z.string(), tags: z.array(z.string()) }).strict();
    expect(fieldSignature(a)).toBe(fieldSignature(b));
  });

  it('preserves optionality alongside the recursed field type', () => {
    // Optionality must remain part of the signature: a required string field and
    // an optional string field of the same name are not interchangeable.
    const required = z.object({ note: z.string() }).strict();
    const optional = z.object({ note: z.string().optional() }).strict();
    expect(fieldSignature(required)).not.toBe(fieldSignature(optional));
  });
});
