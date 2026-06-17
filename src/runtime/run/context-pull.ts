import { ContextRequest } from '../../schemas/context-request.js';
import type { ContextQuery } from '../../schemas/context-request.js';

export type { ContextQuery, ContextRequest };

// On-demand context-pull — the typed-lookup channel, runtime half.
//
// The validated sibling of equipment reshape. Where reshape injects equipment
// into the remaining steps, context-pull lets a RUNNING step ask a parent for
// one more named slice of context on demand, through a typed queryable surface.
// This is the cheapest validated cut only: a typed lookup against a parent's
// typed report. No retrieval, no semantic engine, no "everything" channel.
//
// Like the reshaper, this is a closure that owns a small budget and is fail-safe
// by construction: every refusal, exhaustion, or unanswerable lookup becomes a
// finding the caller records in the trace, and the step proceeds on the context
// it already has. A run that never asks is byte-identical to today. The budget is
// PER-STEP: the live seam builds a fresh puller for each step's batch of queries,
// so one step pulling its fill never starves the next (the conservative default
// in the design note). Independent steps hold independent budgets by construction.

export const CONTEXT_PULL_BUDGET = 3;

// A field_path of '*' (or empty) is the "give me everything" smell. The typed
// channel refuses it on sight and surfaces it as a finding — the operator sees a
// step that wanted the whole parent instead of a named slice.
const EVERYTHING_SENTINEL = '*';

// The queryable surface the channel resolves against: parent step id -> that
// parent's typed report JSON. The live seam materializes this by reading each
// queried parent's report file just-in-time; the channel itself stays pure and
// synchronous so it is trivially unit-testable with a hand-built surface.
export type ContextPullSurface = ReadonlyMap<string, unknown>;

export type ContextPullOutcome =
  | {
      readonly answered: true;
      readonly value: unknown;
      readonly bytes: number;
      readonly source: string;
    }
  | { readonly answered: false; readonly finding: string };

export type ContextPuller = (input: {
  readonly fromStepId: string;
  readonly query: ContextQuery;
  readonly surface: ContextPullSurface;
}) => ContextPullOutcome;

// Field-tolerant read of a `context_request` off a relay's result body. Mirrors
// extractEquipmentDiscovery: the top-level key is optional, malformed payloads
// safeParse to undefined, and a non-object body is simply "no request". A step
// that emits nothing here is byte-identical to a step from before this channel.
export function extractContextRequest(report: unknown): ContextRequest | undefined {
  if (report === null || typeof report !== 'object') return undefined;
  const candidate = (report as { context_request?: unknown }).context_request;
  if (candidate === undefined) return undefined;
  const parsed = ContextRequest.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function finding(message: string): ContextPullOutcome {
  return { answered: false, finding: message };
}

// Resolve a dotted field_path to ONE own field of the parent's typed report.
// Deliberately NOT the shared resolveDottedPath: field_path is untrusted model
// free text, and a bare `cursor[segment]` descent resolves prototype-chain keys
// ('__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', ...) that
// name no report field — answering them would breach the typed-lookup rail. Each
// segment must be an OWN property (every real field of a JSON-parsed report is);
// a non-own key, a missing key, or a descent into a non-object/array throws, and
// the caller parks the throw as a finding. A terminal array value is fine — only
// descending THROUGH a non-object is refused.
function resolveOwnFieldPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      throw new Error(`field_path '${path}' descended into a non-object at segment '${segment}'`);
    }
    if (!Object.hasOwn(cursor, segment)) {
      throw new Error(`field_path '${path}' names no own field at segment '${segment}'`);
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function byteSizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

// Build one typed-lookup channel with its own budget. The seam calls this once
// per step that asks, so the budget is per-step. The returned function resolves
// one query at a time against the surface it is handed, spending budget only on
// answered pulls. Refusals (everything-ask, exhausted budget, unknown parent,
// unanswerable path) never throw and never draw the budget down.
export function createContextPuller(): ContextPuller {
  const budget = { remaining: CONTEXT_PULL_BUDGET };

  return ({ fromStepId, query, surface }) => {
    const path = query.field_path.trim();

    // 1. Refuse the untyped "everything" ask before anything else.
    if (path === EVERYTHING_SENTINEL || path === '') {
      return finding(
        `context pull from step '${fromStepId}' asked for "everything" (field_path '${query.field_path}'); refused — name one typed slice, or narrow the envelope`,
      );
    }

    // 2. Bound by the per-run budget; exhaustion degrades to "proceed as-is".
    if (budget.remaining <= 0) {
      return finding(
        `context pull budget exhausted at step '${fromStepId}'; recorded as a finding, step proceeds on current context`,
      );
    }

    // 3. The named parent must have a readable typed report on the surface.
    if (!surface.has(query.from_step)) {
      return finding(
        `context pull from step '${fromStepId}' named parent '${query.from_step}', which has no readable typed report; recorded as a finding`,
      );
    }

    // 4. Resolve the one named own field; an unanswerable path is a finding, not a throw.
    const root = surface.get(query.from_step);
    let value: unknown;
    try {
      value = resolveOwnFieldPath(root, path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return finding(
        `context pull '${query.from_step}.${path}' is unanswerable: ${message}; recorded as a finding`,
      );
    }

    // Only a real answer spends the budget.
    budget.remaining -= 1;
    return {
      answered: true,
      value,
      bytes: byteSizeOf(value),
      source: `${query.from_step}.${path}`,
    };
  };
}
