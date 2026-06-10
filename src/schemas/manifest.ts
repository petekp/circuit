import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CompiledFlowId, RunId } from './ids.js';
import { Sha256 } from './ref.js';

// MANIFEST-I1 — A ManifestSnapshot is the byte-for-byte copy of the
// flow manifest taken at run bootstrap. `bytes_base64` carries the
// exact persisted manifest bytes (base64 for JSON transport); `hash` is
// SHA-256 over those raw persisted bytes, as a 64-char lowercase hex
// string. SHA-256-over-raw-bytes is the default; any canonicalization
// (e.g. RFC 8785 JCS) would be a deliberate future change.
//
// MANIFEST-I2 — `hash === sha256(decoded bytes_base64)` is enforced at
// parse time. A ManifestSnapshot whose declared hash disagrees with its
// declared bytes is structurally invalid: the reader cannot tell which
// side is corrupt, so parsing fails rather than silently accepting.
//
// MANIFEST-I3 — `run_id`/`flow_id` must match the run.bootstrapped
// trace_entry at re-entry. Enforced at run-projection level, not here.

// ManifestHash is the canonical 64-hex SHA-256 scalar (src/schemas/ref.ts).
// Re-exported under the manifest-domain name its callers expect.
export const ManifestHash = Sha256;
export type ManifestHash = z.infer<typeof ManifestHash>;

const BASE64 = /^[A-Za-z0-9+/=\r\n]*$/;

export const ManifestSnapshot = z
  .object({
    schema_version: z.literal(1),
    run_id: RunId,
    flow_id: CompiledFlowId,
    captured_at: z.iso.datetime(),
    algorithm: z.literal('sha256-raw'),
    hash: ManifestHash,
    bytes_base64: z.string().regex(BASE64, {
      message: 'bytes_base64 must be base64-encoded (RFC 4648 alphabet)',
    }),
  })
  .strict()
  .superRefine((snap, ctx) => {
    let decoded: Buffer;
    try {
      decoded = Buffer.from(snap.bytes_base64, 'base64');
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['bytes_base64'],
        message: 'bytes_base64 failed to decode as base64',
      });
      return;
    }
    const computed = createHash('sha256').update(decoded).digest('hex');
    if (computed !== snap.hash) {
      ctx.addIssue({
        code: 'custom',
        path: ['hash'],
        message: `manifest hash mismatch: declared=${snap.hash} computed=${computed} (sha256 over decoded bytes_base64)`,
      });
    }
  });
export type ManifestSnapshot = z.infer<typeof ManifestSnapshot>;

export function computeManifestHash(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
