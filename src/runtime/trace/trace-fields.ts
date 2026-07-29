// Shared, typed trace-field accessors and derivations.
//
// Runtime consumers (progress projection, graph runner, checkpoint resume)
// repeatedly read individual fields off trace entries and re-derive the same
// enums (run outcome, relay role, connector, fanout policy) inline, each with
// its own hand-rolled narrowing. This module is the single home for those
// reads so the behavior is defined once and audited once.
//
// Design constraint (REP-R1 readiness): every accessor narrows on `entry.kind`
// or reads a field through an `unknown` view of the entry, never through a
// `keyof TraceEntry` indexed type. That keeps each accessor valid whether
// `TraceEntry` is the current loose runtime shape (every field optional and
// widened) or the strict discriminated union it will become. Flipping the type
// must not require rewriting anything here.
//
// Every accessor reproduces the prior inline behavior EXACTLY. Where two
// former call sites differed (e.g. a `string[]` vs `readonly string[]`
// return), the difference is preserved by separate, explicitly-typed helpers
// rather than silently unified.

import { BUILTIN_CONNECTOR_CAPABILITIES } from '../../schemas/connector.js';
import { EnabledConnector, type ResolvedConnector } from '../../schemas/connector.js';
import type { FilesystemCapability } from '../../schemas/connector.js';
import type { FanoutStep } from '../../schemas/step.js';
import { RunClosedOutcome } from '../../schemas/trace-entry.js';
import type { TraceEntry } from '../domain/trace.js';

// A field-name-keyed view of a trace entry. Reading through this view does not
// depend on the field being declared on the (loose or strict) `TraceEntry`
// type, so the accessors survive the REP-R1 strict re-base unchanged.
type TraceFieldView = Readonly<Record<string, unknown>>;

function fieldView(entry: TraceEntry): TraceFieldView {
  return entry as unknown as TraceFieldView;
}

/**
 * Read a non-empty string field off a trace entry.
 *
 * Mirrors the prior `traceString` helpers in checkpoint-resume.ts and
 * runtime-run-folder.ts: returns the value only when it is a string with
 * length > 0, otherwise `undefined`.
 */
export function traceString(entry: TraceEntry, key: string): string | undefined {
  const value = fieldView(entry)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read a finite number field off a trace entry.
 *
 * Mirrors the prior `traceNumber` helper in runtime-run-folder.ts.
 */
export function traceNumber(entry: TraceEntry, key: string): number | undefined {
  const value = fieldView(entry)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Read a homogeneous, non-empty string-array field off a trace entry.
 *
 * Mirrors the prior `stringArray`/`traceStringArray` helpers: returns the
 * array only when every element is a string AND the array is non-empty,
 * otherwise `undefined`. Returns `readonly string[]`; the projection call
 * sites that wanted a mutable `string[]` spread it explicitly.
 */
export function traceStringArray(entry: TraceEntry, key: string): readonly string[] | undefined {
  return stringArrayValue(fieldView(entry)[key]);
}

/**
 * Value-level companion to {@link traceStringArray} for fields already pulled
 * off an entry as `unknown` (e.g. `entry.branch_ids`, `entry.options`).
 * Preserves the exact predicate the inline helpers used and returns a fresh
 * mutable array, matching the prior progress-projection `stringArray` helper
 * (its callers pass the result straight into mutable progress-event fields).
 */
export function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((item): item is string => typeof item === 'string');
  return entries.length === value.length && entries.length > 0 ? entries : undefined;
}

// --- Run outcome ---------------------------------------------------------

/**
 * The canonical run-closed outcome literals, sourced from the zod enum in
 * `schemas/trace-entry.ts`. The single source of truth for the value set.
 */
export const RUN_CLOSED_OUTCOMES = RunClosedOutcome.options;

/**
 * Type guard for an unknown value being a {@link RunClosedOutcome}. Replaces
 * the hand-rolled `isRunClosedOutcome` chains across the runtime.
 */
export function isRunClosedOutcome(value: unknown): value is RunClosedOutcome {
  return (RUN_CLOSED_OUTCOMES as readonly string[]).includes(value as string);
}

/**
 * Read the `outcome` field off a `run.closed` entry, falling back to
 * `'aborted'` when it is missing or unrecognized.
 *
 * Mirrors progress.ts `runOutcome`.
 */
export function runOutcome(entry: TraceEntry): RunClosedOutcome {
  const outcome = fieldView(entry).outcome;
  return isRunClosedOutcome(outcome) ? outcome : 'aborted';
}

/**
 * Read the optional `reason` field off a trace entry as a non-empty string.
 *
 * Mirrors progress.ts `runReason`.
 */
export function runReason(entry: TraceEntry): string | undefined {
  const reason = fieldView(entry).reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : undefined;
}

/**
 * Read a child/run outcome field as a {@link RunClosedOutcome} when
 * recognized, otherwise `undefined` (no fallback). Mirrors progress.ts
 * `fanoutChildOutcome` and runtime-run-folder.ts `runtimeRunOutcome`.
 */
export function optionalRunClosedOutcome(value: unknown): RunClosedOutcome | undefined {
  return isRunClosedOutcome(value) ? value : undefined;
}

// --- Relay role ----------------------------------------------------------

type ProgressRelayRole = 'researcher' | 'reviewer' | 'implementer';

const PROGRESS_RELAY_ROLES: readonly ProgressRelayRole[] = [
  'researcher',
  'reviewer',
  'implementer',
];

/**
 * Read the relay `role` off a trace entry, narrowed to the progress-relevant
 * subset. Mirrors progress.ts `relayRoleFromTrace`.
 */
export function relayRoleFromTrace(entry: TraceEntry): ProgressRelayRole | undefined {
  const role = fieldView(entry).role;
  return PROGRESS_RELAY_ROLES.includes(role as ProgressRelayRole)
    ? (role as ProgressRelayRole)
    : undefined;
}

export type { ProgressRelayRole };

// --- Connector -----------------------------------------------------------

/**
 * Reconstruct a {@link ResolvedConnector} from a trace entry's `connector`
 * field, validating the discriminant shape. Mirrors progress.ts
 * `connectorFromTrace` exactly.
 */
export function connectorFromTrace(entry: TraceEntry): ResolvedConnector | undefined {
  const connector = fieldView(entry).connector;
  if (connector === undefined || connector === null || typeof connector !== 'object') {
    return undefined;
  }
  const record = connector as Record<string, unknown>;
  if (
    record.kind === 'builtin' &&
    typeof record.name === 'string' &&
    (EnabledConnector.options as readonly string[]).includes(record.name)
  ) {
    return { kind: 'builtin', name: record.name as EnabledConnector };
  }
  if (
    record.kind === 'custom' &&
    typeof record.name === 'string' &&
    Array.isArray(record.command) &&
    record.capabilities !== undefined
  ) {
    return connector as ResolvedConnector;
  }
  return undefined;
}

/**
 * Resolve the filesystem capability for a {@link ResolvedConnector}. Mirrors
 * progress.ts `connectorFilesystemCapability`.
 */
export function connectorFilesystemCapability(connector: ResolvedConnector): FilesystemCapability {
  return connector.kind === 'builtin'
    ? BUILTIN_CONNECTOR_CAPABILITIES[connector.name].filesystem
    : connector.capabilities.filesystem;
}

// --- Fanout --------------------------------------------------------------

// Single-sourced from the flow schema rather than re-spelling the literals.
type FanoutJoinPolicy = FanoutStep['check']['join']['policy'];

const FANOUT_JOIN_POLICIES: readonly FanoutJoinPolicy[] = [
  'pick-winner',
  'disjoint-merge',
  'aggregate-only',
  'aggregate-any',
  'aggregate-survivors',
];

/**
 * Narrow an unknown value to a fanout join policy. Mirrors progress.ts
 * `fanoutPolicy`.
 */
export function fanoutPolicy(value: unknown): FanoutJoinPolicy | undefined {
  return FANOUT_JOIN_POLICIES.includes(value as FanoutJoinPolicy)
    ? (value as FanoutJoinPolicy)
    : undefined;
}

type FanoutBranchKind = 'relay' | 'sub-run';

/**
 * Narrow an unknown value to a fanout branch kind. Mirrors progress.ts
 * `fanoutBranchKind`.
 */
export function fanoutBranchKind(value: unknown): FanoutBranchKind | undefined {
  return value === 'relay' || value === 'sub-run' ? value : undefined;
}

export type { FanoutJoinPolicy, FanoutBranchKind };
