function resolveOwnResultField(root: unknown, path: readonly string[]): unknown {
  let cursor = root;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return undefined;
    }
    if (!Object.hasOwn(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function isEmptyJsonValue(value: unknown): boolean {
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return value !== null && typeof value === 'object' && Object.keys(value).length === 0;
}

/**
 * Returns the first deterministic result-field admission failure, if any.
 * Missing fields, null, booleans, and numbers are not considered empty. This
 * keeps an absent or malformed field from satisfying an explicit condition.
 */
export function requiredEmptyResultFieldFailure(
  check: { readonly require_empty?: readonly (readonly string[])[] | undefined },
  resultBody: unknown,
): string | undefined {
  for (const path of check.require_empty ?? []) {
    const value = resolveOwnResultField(resultBody, path);
    if (!isEmptyJsonValue(value)) {
      return `result field '${path.join('.')}' must be empty`;
    }
  }
  return undefined;
}
