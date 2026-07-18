import { createHash } from 'node:crypto';

export type CheckpointReviewInputIdentity = {
  readonly path: string;
  readonly sha256: string;
};

export function normalizeCheckpointReviewInputPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
  }
  return normalized;
}

export function normalizeCheckpointReviewInputIdentities(
  identities: readonly CheckpointReviewInputIdentity[],
): CheckpointReviewInputIdentity[] {
  const byPath = new Map<string, string>();
  const normalized: CheckpointReviewInputIdentity[] = [];
  for (const identity of identities) {
    const existing = byPath.get(identity.path);
    if (existing !== undefined) {
      if (existing !== identity.sha256) {
        throw new Error(`checkpoint review input '${identity.path}' has conflicting identities`);
      }
      continue;
    }
    byPath.set(identity.path, identity.sha256);
    normalized.push(identity);
  }
  return normalized;
}

export function checkpointReviewInputSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function checkpointReviewInputJsonObject(
  bytes: Uint8Array,
): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
